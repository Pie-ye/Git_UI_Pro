export interface TrellisChecklistItem {
  checked: boolean;
  text: string;
}

export interface TrellisChecklistResult {
  checked: number;
  total: number;
  maintained: boolean;
  ratio?: number;
  uncheckedSamples: string[];
  items: TrellisChecklistItem[];
}

const UNCHECKED = /^(\s*)- \[ \] (.+)$/u;
const CHECKED = /^(\s*)- \[[xX]\] (.+)$/u;
const FENCE = /^(\s*)```/u;

export function parseChecklist(markdown?: string, sampleLimit = 3): TrellisChecklistResult {
  if (!markdown) {
    return {
      checked: 0,
      total: 0,
      maintained: false,
      uncheckedSamples: [],
      items: []
    };
  }

  let inFence = false;
  const items: TrellisChecklistItem[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const checked = CHECKED.exec(line);
    if (checked) {
      items.push({ checked: true, text: checked[2].trim() });
      continue;
    }
    const unchecked = UNCHECKED.exec(line);
    if (unchecked) {
      items.push({ checked: false, text: unchecked[2].trim() });
    }
  }

  const total = items.length;
  const checked = items.reduce((count, item) => count + (item.checked ? 1 : 0), 0);
  const maintained = total > 0;
  return {
    checked,
    total,
    maintained,
    ratio: maintained ? checked / total : undefined,
    uncheckedSamples: items.filter((item) => !item.checked).slice(0, sampleLimit).map((item) => item.text),
    items
  };
}
