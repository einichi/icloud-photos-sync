/**
 * This script exposes the triggerSync() and triggerReauth() functions.
 * Additionally the refreshState() function will be executed through an interval.
 */
export const stateViewScript = (basePath: string) => `
let previousErrorText = "";

async function triggerSync() {
    const response = await fetch("${basePath}/api/sync", { method: "POST" });
    if (!response.ok) {
        alert("Unable to trigger sync: " + response.statusText);
        return;
    }
    await refreshState()
}
async function triggerReauth() {
    const response = await fetch("${basePath}/api/reauthenticate", { method: "POST" });
    if (!response.ok) {
        alert("Unable to trigger re-authentication: " + response.statusText);
        return;
    }
    await refreshState()
}

async function submitCredentials(event) {
    event.preventDefault();

    const usernameInput = document.getElementById('credential-username');
    const passwordInput = document.getElementById('credential-password');
    const submitButton = document.getElementById('credential-submit-button');

    submitButton.disabled = true;
    const response = await fetch("${basePath}/api/credentials", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            username: usernameInput.value,
            password: passwordInput.value
        })
    });
    passwordInput.value = "";
    submitButton.disabled = false;

    if (!response.ok) {
        alert("Unable to submit credentials: " + response.statusText);
        return;
    }

    await refreshState()
}

async function copyPreviousError() {
    if (!previousErrorText) {
        return;
    }

    const button = document.getElementById('copy-error-button');
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(previousErrorText);
        } else {
            const textArea = document.createElement('textarea');
            textArea.value = previousErrorText;
            textArea.setAttribute('readonly', '');
            textArea.style.position = 'fixed';
            textArea.style.top = '-1000px';
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }

        if (button) {
            button.classList.add('copied');
            button.title = 'Copied error message';
            setTimeout(() => {
                button.classList.remove('copied');
                button.title = 'Copy error message';
            }, 1500);
        }
    } catch (err) {
        alert('Unable to copy error message: ' + err.message);
    }
}

async function refreshState() {
    const state = await fetchState()
    resetState()
    updateState(state)
}

async function fetchState() {
    try{
        const fetchedState = await fetch("${basePath}/api/state", { 
            headers: {
                "Accept": "application/json"
            }
        })

        if(!fetchedState.ok) {
            throw new Error('Response not ok!')
        }
        
        return fetchedState.json();
    } catch (err) {

        console.log(err)
        return {
            state: 'ready',
            prevError: {
                message: 'Connection lost, please refresh!',
                code: 'CLIENT_ERR-CONNECTION_LOST'
            },
            timestamp: Date.now()
        };
    }
}

function setStateText(text) {
    document.querySelector("#state-text").innerHTML = text
}

function setCopyableErrorText(text) {
    const button = document.getElementById('copy-error-button');
    previousErrorText = text ?? "";
    if (button) {
        button.style.display = previousErrorText ? "inline-flex" : "none";
        button.classList.remove('copied');
        button.title = 'Copy error message';
    }
}

function escapeHtml(text) {
    const el = document.createElement("span");
    el.textContent = text ?? "";
    return el.innerHTML;
}

function setRunningStateText(text, detail) {
    const safeText = escapeHtml(text ?? "Syncing...");
    const safeDetail = detail ? "<span class='progress-detail'>" + escapeHtml(detail) + "</span>" : "";
    document.querySelector("#state-text").innerHTML = safeText + safeDetail;
}

function formatInlineError(message) {
    return "<span style='color: red; font-weight: bold'>" + escapeHtml(message) + "</span>";
}

function formatReadyFailureText(state) {
    return "Last " + (state.prevTrigger ?? "operation") + " failed at<br/>" +
        formatDate(state.timestamp) +
        "<br/><br/>" +
        formatInlineError(state.prevError.message);
}

function getReadyFailurePlainText(state) {
    return "Last " + (state.prevTrigger ?? "operation") + " failed at\\n" +
        formatDate(state.timestamp) +
        "\\n\\n" +
        state.prevError.message;
}

function formatReadySuccessText(state) {
    return "Last " + (state.prevTrigger ?? "operation") + " successful at<br/>" +
        formatDate(state.timestamp) +
        formatTokenExpiry(state);
}

function formatTokenExpiry(state) {
    if (!state.trustTokenExpiresAt) {
        return "";
    }

    const remainingMs = state.trustTokenExpiresAt - Date.now();
    const absoluteExpiry = formatDate(state.trustTokenExpiresAt);
    if (remainingMs <= 0) {
        return "<br/><br/>MFA token expired at<br/>" + absoluteExpiry;
    }

    const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const remainingHours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const remaining = remainingDays > 0
        ? remainingDays + "d " + remainingHours + "h"
        : remainingHours + "h";

    return "<br/><br/>MFA token expires in " + remaining + "<br/>" + absoluteExpiry;
}

function formatCount(value) {
    return value === undefined || value === null ? "0" : Number(value).toLocaleString();
}

function formatDuration(durationMs) {
    if (durationMs === undefined || durationMs === null) {
        return "0s";
    }

    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes === 0) {
        return seconds + "s";
    }

    return minutes + "m " + seconds + "s";
}

function setLastSyncStats(stats) {
    const statsContainer = document.getElementById('last-sync-stats');
    if (!statsContainer) {
        return;
    }

    if (!stats) {
        statsContainer.style.display = "none";
        statsContainer.innerHTML = "";
        return;
    }

    const heading = stats.status === "failed" ? "Last failed sync" : "Last completed sync";
    const hashChecked = stats.hashCheckingOccurred
        ? formatCount(stats.hashCheckedCount) + "/" + formatCount(stats.hashCheckTotal)
        : "0";
    const rows = [
        ["Finished", stats.finishedAt ? formatDate(stats.finishedAt) : "0"],
        ["Duration", formatDuration(stats.durationMs)],
        ["Remote assets", formatCount(stats.remoteAssetCount)],
        ["Local assets", formatCount(stats.localAssetCount)],
        ["Remote albums", formatCount(stats.remoteAlbumCount)],
        ["Local albums", formatCount(stats.localAlbumCount)],
        ["New downloads", formatCount(stats.newDownloadCount)],
        ["Redownloads", formatCount(stats.redownloadCount)],
        ["Hash checked", hashChecked],
        ["Warnings/errors", formatCount(stats.warningErrorCount)],
    ];

    statsContainer.innerHTML = "<h2>" + heading + "</h2><dl>" + rows.map(([label, value]) => {
        return "<dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(value) + "</dd>";
    }).join("") + "</dl>";
    statsContainer.style.display = "block";
}

function setProgress(progress) {
    if(progress !== undefined && progress !== null && progress >= 0) {
        const boundedProgress = Math.max(0, Math.min(progress, 100));
        document.getElementById('progress-container').style.display = "block";
        document.getElementById('progress-bar').style.width = boundedProgress + '%';
    } else {
        document.getElementById('progress-container').style.display = "none";
        document.getElementById('progress-bar').style.width = '0%';
    }
}

function enableSymbol(symbolName) {
    document.querySelector("#" + symbolName + "-symbol").style.display = "block";
}

/**
 * This function resets the state and hides all dynamic elements
 */
function resetState() {
    setStateText('...')
    setCopyableErrorText("")
    setProgress()
    document.querySelectorAll(".state-symbol").forEach((el) => {
        el.style.display = "none";
    });
    document.querySelectorAll(".hidden-when-not-ready").forEach((el) => {
        el.style.display = "none";
    });
    document.getElementById('credential-container').style.display = "none";
    document.getElementById('last-sync-stats').style.display = "none";
    document.getElementById('last-sync-stats').innerHTML = "";
}

/**
 * This function fetches the current app state and applies changes to the view
 * @param state - expects the json object form the API or undefined (will reload page on undefined)
 */
function updateState(state) {
    if(!state) {
        window.location.reload();
    }

    if(state.nextSync) {
        document.querySelector("#next-sync-time").innerHTML = formatDate(state.nextSync);
    }

    switch (state.state) {
        case 'ready':
            // Increase time between refresh while application is idle
            setTimeout(() => refreshState(), 5000);

            if(!state.hasCredentials) {
                document.getElementById('credential-container').style.display = "flex";
                setStateText("Apple ID credentials are required after each service restart.")
                enableSymbol('unknown')
                return
            }

            document.querySelectorAll(".hidden-when-not-ready").forEach((el) => {
                el.style.display = "block";
            });
            setLastSyncStats(state.lastSyncStats);

            // If there was an error reported, show it
            if(state.prevError) {
                setCopyableErrorText(getReadyFailurePlainText(state))
                setStateText(formatReadyFailureText(state))
                enableSymbol('error')
                return
            } 

            enableSymbol('ok')

            if(!state.prevTrigger) {
                setStateText("Application ready" + formatTokenExpiry(state))
                return
            }

            setStateText(formatReadySuccessText(state))
            return;
        case 'blocked': 
            navigate('${basePath}/submit-mfa')
            return;
        case 'running':
            // Decrease time between refresh while application is running
            setTimeout(() => refreshState(), 500);

            setRunningStateText(state.progressMsg, state.progressDetail)
            setProgress(state.progress)
            enableSymbol('running')

            return;
        default:
            setTimeout(() => refreshState(), 5000);

            setStateText('Unknown')
            enableSymbol('unknown')
            return;
    }
}

// Kick off function to update state
setTimeout(() => refreshState(), 0);
`
