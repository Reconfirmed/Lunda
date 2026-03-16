LUNDA - OPTIMIZED BRANCH STALENESS CHECKER
==========================================

we store a sorted list of branches with their "days until stale"
we schedule the next run for exactly when the first branch will become stale
if a branch was updated, we walk forward through the list until we find one that wasn't


FULL_SCAN():
    get all branches
    
    for each branch:
        get its latest commit SHA
        calculate days_until_stale = threshold - days_since_last_commit
    
    sort by days_until_stale ascending (soonest to stale first)
    
    report any where days_until_stale <= 0 (already stale)
    remove those from list
    
    save the list
    schedule next run for list[0].days_until_stale days from now


OPTIMIZED_CHECK():
    load saved list
    
    check the first branch (the one we scheduled this run for)
    
    if it was deleted:
        remove it from list
    
    else if its SHA is the same as before:
        it's stale now - report it
        remove it from list
    
    else (it was updated):
        recalculate its days_until_stale
        
        walk forward through the rest of the list:
            if branch was deleted:
                remove it
            else if SHA is same as before:
                stop - everything after this is unchanged too
            else:
                recalculate its days_until_stale
        
        re-sort the list
    
    save the list
    schedule next run for list[0].days_until_stale days from now


RUN():
    if no saved data exists:
        FULL_SCAN()
    
    else if threshold setting changed:
        FULL_SCAN()
    
    else if it's been threshold days since last full scan:
        FULL_SCAN()  # catch any new branches
    
    else:
        OPTIMIZED_CHECK()
