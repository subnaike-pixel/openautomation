'use strict';

const logArea = document.getElementById('log-area');
const statusMsg = document.getElementById('status-msg');
const progressBar = document.getElementById('progress-bar');
const splashSub = document.getElementById('splash-sub');

function appendLog(msg) {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = msg;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function setStatus(msg, cls) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (cls ? ' ' + cls : '');
}

// Signal main that splash is ready
window.splash.ready();

window.splash.onLog((msg) => {
  appendLog(msg.trim());
  setStatus(msg.trim().slice(0, 80));
});

window.splash.onDone(() => {
  progressBar.classList.add('done');
  splashSub.textContent = 'Ready!';
  setStatus('✓ Ready! Loading OpenAutomation…', 'done-msg');
  // Fade out body
  setTimeout(() => {
    document.body.style.transition = 'opacity 0.5s';
    document.body.style.opacity = '0';
  }, 800);
});

window.splash.onError((err) => {
  progressBar.style.background = '#ef4444';
  progressBar.style.animation = 'none';
  progressBar.style.width = '100%';
  setStatus('Error: ' + err, 'error-msg');
  appendLog('❌ ' + err);
});

