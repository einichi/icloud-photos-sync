export const stateViewCSS = `
.state-symbol {
    margin: 1rem;
    width: 35%;
    display: none;
    text-align: center;
    font-size: 7rem;
    color: orange;
}
.state-symbol svg {
    width: 100%;
    height: 100%;
}
#unknown-symbol {
    color: inherit;
    font-size: 4rem;
    line-height: 1;
}
#running-symbol {
    animation: rotate 10s linear infinite;
}
@keyframes rotate {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}
#state-text {
    text-align: center;
    width: 75%;
    margin: auto;
    margin-top: 1rem;
    margin-bottom: 1rem;
}
.copy-error-button {
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    min-width: 2rem;
    padding: 0;
    margin: -0.35rem auto 0.75rem;
}
.copy-error-button svg {
    width: 1rem;
    height: 1rem;
    fill: currentColor;
}
.copy-error-button.copied {
    background-color: #6BBE66;
    border-color: #6BBE66;
}
.progress-detail {
    display: block;
    margin-top: 0.35rem;
    overflow-wrap: anywhere;
    font-family: monospace;
    font-size: 0.9rem;
}
#next-sync-text {
    text-align: center;
}
.credential-container {
    width: 80%;
    max-width: 24rem;
    margin: 1rem auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}
.credential-container input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border: 1px solid #9aa3b2;
    border-radius: 0.25rem;
    font-size: 1rem;
}
.credential-container button {
    width: 100%;
}
#enter-mfa-section {
    text-align: center;
    width: 90%;
    margin: auto;
    margin-bottom: 1rem;
    background-color: #d8d8d8;
    padding: 1rem;
    border-radius: 0.5rem;
    box-sizing: border-box;
}
#enter-mfa-section button {
    width: 100%;
}

.progress-container {
    width: 80%;
    height: 0.5rem;
    background-color: #e0e0e0;
    border-radius: 0.25rem;
    overflow: hidden;
    margin: 1rem auto;
    display: block;
    position: relative;
}
.progress-bar {
    height: 100%;
    background-color: rgb(66, 129, 255);
    width: 0%;
    transition: width 0.3s ease;
    border-radius: 0.25rem;
}
.progress-bar.indeterminate {
    width: 30%;
    animation: indeterminate 1.5s ease-in-out infinite;
    transition: none;
}
.last-sync-stats {
    width: 80%;
    max-width: 28rem;
    margin: 1rem auto 0;
    font-size: 0.9rem;
}
.last-sync-stats h2 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 700;
}
.last-sync-stats dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.35rem 1rem;
    margin: 0;
}
.last-sync-stats dt {
    color: #687386;
}
.last-sync-stats dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    text-align: right;
}
@keyframes indeterminate {
    0% {
        transform: translateX(-100%);
    }
    100% {
        transform: translateX(400%);
    }
}
`

export const stateViewCSSDark = `
 #progress-container {
    border: 1px solid #555;
}

#state-text {
    color: #e0e0e0;
}

.credential-container input {
    background-color: #222;
    border-color: #555;
    color: #e0e0e0;
}
    
#enter-mfa-section {
    background-color: #3a3a3a;
}

.last-sync-stats dt {
    color: #b0b8c4;
}
`
