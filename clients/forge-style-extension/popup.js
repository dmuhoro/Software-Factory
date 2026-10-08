const baseUrlInput = document.getElementById('baseUrl');
const tenantIdInput = document.getElementById('tenantId');
const apiKeyInput = document.getElementById('apiKey');
const connectBtn = document.getElementById('connect');
const panel = document.getElementById('panel');
const repoInput = document.getElementById('repo');
const taskInput = document.getElementById('taskDocument');
const submitBtn = document.getElementById('submit');
const goalInput = document.getElementById('goal');
const providerInput = document.getElementById('providerId');
const modelInput = document.getElementById('model');
const draftBtn = document.getElementById('draft');
const runsPre = document.getElementById('runs');
const outPre = document.getElementById('out');

let state = null;

connectBtn.addEventListener('click', () => {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, '');
  const tenantId = tenantIdInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  if (!baseUrl || !tenantId || !apiKey) {
    outPre.textContent = 'Set baseUrl, tenantId, apiKey';
    return;
  }
  state = { baseUrl, tenantId, apiKey };
  panel.classList.remove('hidden');
  outPre.textContent = 'Connected (memory-only)';
  refreshRuns();
  setInterval(refreshRuns, 5000);
});

async function call(method, path, body) {
  if (!state) throw new Error('not connected');
  const res = await fetch(state.baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.apiKey,
      'x-tenant-id': state.tenantId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(res.status + ': ' + (typeof json === 'object' ? (json.message || JSON.stringify(json)) : json));
  return json;
}

async function refreshRuns() {
  try {
    const data = await call('GET', '/api/loop/runs');
    runsPre.textContent = JSON.stringify(data.runs || [], null, 2);
  } catch (e) {
    runsPre.textContent = String(e);
  }
}

submitBtn.addEventListener('click', async () => {
  try {
    const data = await call('POST', '/api/loop/runs', {
      tenantId: state.tenantId,
      repo: repoInput.value.trim(),
      taskDocument: taskInput.value.trim()
    });
    outPre.textContent = JSON.stringify(data, null, 2);
    refreshRuns();
  } catch (e) {
    outPre.textContent = String(e);
  }
});

draftBtn.addEventListener('click', async () => {
  try {
    const data = await call('POST', '/api/loop/goals', {
      tenantId: state.tenantId,
      repo: repoInput.value.trim(),
      goal: goalInput.value.trim(),
      providerId: providerInput.value.trim(),
      model: modelInput.value.trim()
    });
    taskInput.value = data.taskDocument || '';
    outPre.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    outPre.textContent = String(e);
  }
});
