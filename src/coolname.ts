/**
 * Cool name generation + local username persistence for Clockwork Climb.
 *
 * Username is stored in localStorage under "cc-username". If not set,
 * a random Adjective-Animal-NN name is generated and persisted on first read.
 * No network, no deps.
 */

const ADJECTIVES = [
  "Brave", "Swift", "Bold", "Calm", "Keen", "Vast", "Warm", "Cool",
  "Wise", "Fair", "Pure", "Agile", "Bright", "Clear", "Deep", "Epic",
  "Fierce", "Grand", "Hardy", "Iron", "Jade", "Kind", "Lean", "Mighty",
  "Noble", "Onyx", "Prime", "Quick", "Rapid", "Sharp", "True", "Ultra",
  "Vivid", "Wild", "Amber", "Brisk", "Crisp", "Deft", "Zesty", "Lively",
];

const ANIMALS = [
  "Otter", "Crane", "Lynx", "Raven", "Finch", "Bison", "Gecko", "Ibis",
  "Stoat", "Robin", "Okapi", "Quail", "Moose", "Heron", "Viper", "Dingo",
  "Egret", "Lemur", "Macaw", "Panda", "Tapir", "Wombat", "Coati", "Duiker",
  "Impala", "Jackal", "Marmot", "Narwhal", "Ocelot", "Mink", "Puffin",
  "Ferret", "Kestrel", "Chinchilla", "Capybara", "Axolotl", "Salamander",
  "Tamarin", "Caracal", "Dunnock",
];

const STORAGE_KEY = "cc-username";

/** Returns a random family-friendly Adjective-Animal-NN name, e.g. "Brave-Otter-42". */
export function generateCoolName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  // 10-99 so it's always two digits.
  const num = String(10 + Math.floor(Math.random() * 90));
  return `${adj}-${animal}-${num}`;
}

/**
 * Read the persisted username from localStorage. If absent (first visit),
 * generate a coolname, persist it, and return it.
 */
export function getLocalUsername(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch { /* localStorage may be unavailable (private mode, etc.) */ }
  const name = generateCoolName();
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* ignore */ }
  return name;
}

/**
 * Persist a new username. Trims whitespace, strips illegal characters, caps
 * at 24 chars. An empty result (after cleaning) falls back to a fresh coolname.
 */
export function setLocalUsername(name: string): void {
  let clean = name.trim().replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 24).trim();
  if (!clean) clean = generateCoolName();
  try { localStorage.setItem(STORAGE_KEY, clean); } catch { /* ignore */ }
}
