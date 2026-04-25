import { Octokit } from "@octokit/rest";

// Initialize Octokit with the GITHUB_TOKEN from environment variables
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const repository = process.env.GITHUB_REPOSITORY;
if (!repository) {
  throw new Error("GITHUB_REPOSITORY environment variable is required (format: owner/repo)");
}

// GitHub gives repo in "owner/repo" format, e.g., "Reconfirmed/Lunda"
const [owner, repo] = repository.split("/");

if (!owner || !repo) {
  throw new Error("GITHUB_REPOSITORY must be in owner/repo format");
}

// Parse the DAYS_THRESHOLD from environment variables, defaulting to 90
const DAYS_THRESHOLD: number = parseInt(process.env.INPUT_DAYS_THRESHOLD || "90", 10);

// Path to the workflow file that calls this action (provided as input)
const WORKFLOW_PATH: string = process.env.INPUT_WORKFLOW_PATH || ".github/workflows/lunda.yml";

// Path to store our tracking data
const TRACKING_FILE = "lunda-tracking.json";
const MILLISECONDS_IN_DAY = 1000 * 60 * 60 * 24;
const COMMIT_FETCH_CONCURRENCY = 10;

interface BranchEntry {
  name: string;
  sha: string;                 // SHA to detect updates
  daysUntilStale: number;      // threshold - days_since_last_commit
  calculatedAt: string;        // ISO date when we calculated this
}

interface TrackingData {
  threshold: number;
  lastFullScan: string;
  branches: BranchEntry[];     // sorted by daysUntilStale ascending (soonest to stale first)
}

interface StaleBranch {
  name: string;
  daysSinceLastCommit: number;
}

async function loadTrackingData(): Promise<TrackingData | null> {
  try {
    // Try to fetch from the repo
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: TRACKING_FILE,
    });

    if ("content" in response.data) {
      const content = Buffer.from(response.data.content, "base64").toString("utf-8");
      return JSON.parse(content) as TrackingData;
    }
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 404) {
      console.log("📋 No tracking data found. Will perform initial scan.");
      return null;
    }
    throw err;
  }
  return null;
}

async function saveTrackingData(data: TrackingData): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  const encodedContent = Buffer.from(content).toString("base64");

  let sha: string | undefined;
  try {
    const existing = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: TRACKING_FILE,
    });
    if ("sha" in existing.data) {
      sha = existing.data.sha;
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: TRACKING_FILE,
    message: "chore(lunda): update branch tracking data",
    content: encodedContent,
    sha,
  });

  console.log("💾 Tracking data saved.");
}

async function getLatestCommit(branchName: string): Promise<{ date: string; sha: string } | null> {
  try {
    const response = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: branchName,
      per_page: 1,
    });

    if (response.data.length === 0) return null;

    const commit = response.data[0];
    return {
      date: commit.commit.committer?.date as string,
      sha: commit.sha,
    };
  } catch {
    return null;
  }
}

function calculateDaysUntilStale(lastCommitDate: string): number {
  const now = new Date();
  const commitDate = new Date(lastCommitDate);
  const daysSinceLastCommit = (now.getTime() - commitDate.getTime()) / MILLISECONDS_IN_DAY;
  return Math.ceil(DAYS_THRESHOLD - daysSinceLastCommit);
}

function estimateDaysSinceLastCommit(entry: BranchEntry, now: Date): number {
  const calculatedAt = new Date(entry.calculatedAt);
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - calculatedAt.getTime()) / MILLISECONDS_IN_DAY));
  const estimatedAtCalculation = DAYS_THRESHOLD - entry.daysUntilStale;

  return Math.max(0, estimatedAtCalculation + elapsedDays);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = currentIndex;
      currentIndex++;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

function calculateNextCronDate(daysFromNow: number): string {
  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + Math.max(1, daysFromNow)); // At least 1 day from now

  // GitHub cron format: minute hour day month day-of-week
  // We'll schedule for midnight UTC on the target day
  const day = nextDate.getUTCDate();
  const month = nextDate.getUTCMonth() + 1; // 0-indexed to 1-indexed

  return `0 0 ${day} ${month} *`;
}

async function updateWorkflowCron(newCron: string): Promise<void> {
  console.log(`🔄 Updating workflow cron to: ${newCron}`);

  try {
    // Get the current workflow file
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: WORKFLOW_PATH,
    });

    if (!("content" in response.data)) {
      console.error("❌ Could not read workflow file.");
      return;
    }

    const currentContent = Buffer.from(response.data.content, "base64").toString("utf-8");
    const sha = response.data.sha;

    // Update the cron expression in the workflow file
    // Matches patterns like: - cron: '...' or - cron: "..."
    const cronRegex = /(schedule:\s*\n\s*-\s*cron:\s*)(['"])([^'"]+)\2/;

    if (!cronRegex.test(currentContent)) {
      console.log("⚠️ Could not find cron schedule in workflow file. Skipping cron update.");
      return;
    }

    const updatedContent = currentContent.replace(cronRegex, `$1$2${newCron}$2`);

    if (updatedContent === currentContent) {
      console.log("ℹ️ Cron schedule unchanged.");
      return;
    }

    // Commit the updated workflow file
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: WORKFLOW_PATH,
      message: `chore(lunda): schedule next scan for ${newCron}`,
      content: Buffer.from(updatedContent).toString("base64"),
      sha,
    });

    console.log(`✅ Workflow updated. Next run scheduled for cron: ${newCron}`);
  } catch (err) {
    console.error("❌ Failed to update workflow cron:", err);
  }
}

async function getAllBranches(): Promise<string[]> {
  const branches: string[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.repos.listBranches({
      owner,
      repo,
      per_page: 100,
      page,
    });

    for (const branch of response.data) {
      // Skip main/master branches
      if (!["main", "master"].includes(branch.name)) {
        branches.push(branch.name);
      }
    }

    if (response.data.length < 100) break;
    page++;
  }

  return branches;
}

async function fullScan(): Promise<TrackingData> {
  console.log("🔍 Performing full scan of all branches...\n");

  const branchNames = await getAllBranches();
  const now = new Date().toISOString();

  const branchCandidates = await mapWithConcurrency(
    branchNames,
    COMMIT_FETCH_CONCURRENCY,
    async (name): Promise<BranchEntry | null> => {
      const commit = await getLatestCommit(name);
      if (!commit) {
        console.log(`⚠️ Branch ${name} has no commits. Skipping.`);
        return null;
      }

      return {
        name,
        sha: commit.sha,
        daysUntilStale: calculateDaysUntilStale(commit.date),
        calculatedAt: now,
      };
    },
  );

  const branches = branchCandidates.filter((branch): branch is BranchEntry => branch !== null);

  // sort by daysUntilStale ascending (soonest to stale first)
  branches.sort((a, b) => a.daysUntilStale - b.daysUntilStale);

  return { threshold: DAYS_THRESHOLD, lastFullScan: now, branches };
}

async function optimizedCheck(tracking: TrackingData): Promise<{
  staleBranches: StaleBranch[];
  updatedTracking: TrackingData;
}> {
  console.log("🔍 Performing optimized check...\n");

  const staleBranches: StaleBranch[] = [];
  const now = new Date();
  const nowIso = now.toISOString();
  const { branches } = tracking;

  if (branches.length === 0) {
    console.log("✨ No branches to track.");
    return { staleBranches: [], updatedTracking: tracking };
  }

  // check the first branch (the one we scheduled this run for)
  const first = branches[0];
  const commit = await getLatestCommit(first.name);

  if (!commit) {
    // it was deleted
    console.log(`🗑️ Branch ${first.name} was deleted. Removing from list.`);
    branches.shift();

  } else if (commit.sha === first.sha) {
    // its SHA is the same as before - it's stale now
    console.log(`⏰ Branch ${first.name} is now stale.`);
    staleBranches.push({
      name: first.name,
      daysSinceLastCommit: estimateDaysSinceLastCommit(first, now),
    });
    branches.shift();

  } else {
    // it was updated - recalculate and walk forward
    console.log(`🔄 Branch ${first.name} was updated. Walking forward through list...`);

    first.sha = commit.sha;
    first.daysUntilStale = calculateDaysUntilStale(commit.date);
    first.calculatedAt = nowIso;

    // walk forward through the rest of the list
    for (let i = 1; i < branches.length; i++) {
      const entry = branches[i];
      const entryCommit = await getLatestCommit(entry.name);

      if (!entryCommit) {
        // branch was deleted
        console.log(`🗑️ Branch ${entry.name} was deleted.`);
        branches.splice(i, 1);
        i--;
        continue;
      }

      if (entryCommit.sha === entry.sha) {
        // SHA is same as before - stop, everything after this is unchanged too
        console.log(`✓ Branch ${entry.name} unchanged. Stopping walk.`);
        break;
      }

      // recalculate
      console.log(`🔄 Branch ${entry.name} was also updated.`);
      entry.sha = entryCommit.sha;
      entry.daysUntilStale = calculateDaysUntilStale(entryCommit.date);
      entry.calculatedAt = nowIso;
    }

    // re-sort the list
    branches.sort((a, b) => a.daysUntilStale - b.daysUntilStale);
  }

  return { staleBranches, updatedTracking: tracking };
}

function needsFullRescan(tracking: TrackingData | null): boolean {
  // no saved data exists
  if (!tracking) return true;

  // threshold setting changed
  if (tracking.threshold !== DAYS_THRESHOLD) return true;

  // it's been threshold days since last full scan
  const lastScan = new Date(tracking.lastFullScan);
  const now = new Date();
  const daysSinceLastScan = (now.getTime() - lastScan.getTime()) / MILLISECONDS_IN_DAY;
  return daysSinceLastScan >= DAYS_THRESHOLD;
}

function reportStaleBranches(staleBranches: StaleBranch[]): void {
  if (staleBranches.length > 0) {
    console.log("⚠️ Forgotten branches detected:\n");
    for (const b of staleBranches) {
      console.log(`🔸 ${b.name} — last commit ${b.daysSinceLastCommit} days ago`);
    }
    console.log("");
  } else {
    console.log("✨ No forgotten branches found. Your repo is clean!\n");
  }
}

async function scheduleNextRun(tracking: TrackingData): Promise<void> {
  if (tracking.branches.length > 0) {
    const daysUntilStale = tracking.branches[0].daysUntilStale;
    const cron = calculateNextCronDate(daysUntilStale);
    console.log(`\n📅 Next branch will become stale in ${daysUntilStale} day(s).`);
    await updateWorkflowCron(cron);
  } else {
    console.log("\n📅 No branches to track.");
  }
}

async function run(): Promise<void> {
  console.log("🔍 Lunda is scanning your repository for forgotten branches...\n");
  console.log(`📊 Threshold: ${DAYS_THRESHOLD} days\n`);

  try {
    let tracking = await loadTrackingData();
    let staleBranches: StaleBranch[] = [];

    if (needsFullRescan(tracking)) {
      // log why we're doing a full scan
      if (tracking && tracking.threshold !== DAYS_THRESHOLD) {
        console.log(`⚠️ Threshold changed from ${tracking.threshold} to ${DAYS_THRESHOLD}. Re-scanning.`);
      } else if (tracking) {
        console.log(`🔄 ${DAYS_THRESHOLD} days since last full scan. Re-scanning for new branches.`);
      }

      tracking = await fullScan();

      // report any where daysUntilStale <= 0 (already stale)
      staleBranches = tracking.branches
        .filter((b) => b.daysUntilStale <= 0)
        .map((b) => ({
          name: b.name,
          daysSinceLastCommit: DAYS_THRESHOLD + Math.abs(b.daysUntilStale),
        }));

      // remove those from list
      tracking.branches = tracking.branches.filter((b) => b.daysUntilStale > 0);

    } else {
      const result = await optimizedCheck(tracking);
      staleBranches = result.staleBranches;
      tracking = result.updatedTracking;
    }

    reportStaleBranches(staleBranches);
    await saveTrackingData(tracking);
    await scheduleNextRun(tracking);

  } catch (err) {
    console.error("❌ Lunda encountered an error:", err);
    process.exit(1);
  }
}

run();
