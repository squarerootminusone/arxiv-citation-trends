// Options: optional Semantic Scholar API key and a cache reset.
const keyInput = document.getElementById('key') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;

function say(text: string): void {
  statusEl.textContent = text;
}

async function init(): Promise<void> {
  const { s2ApiKey } = await chrome.storage.sync.get('s2ApiKey');
  keyInput.value = typeof s2ApiKey === 'string' ? s2ApiKey : '';
}

document.getElementById('save')!.addEventListener('click', async () => {
  await chrome.storage.sync.set({ s2ApiKey: keyInput.value.trim() });
  say('Saved.');
});

document.getElementById('clear')!.addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('cit:'));
  await chrome.storage.local.remove(keys);
  say(`Cleared ${keys.length} cached paper${keys.length === 1 ? '' : 's'}.`);
});

void init();

export {};
