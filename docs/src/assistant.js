/* The gamedev.pl mascot on FX Lab: explains graphics effects and stages, toggles split-screen
   and triggers interactive simulations. Uses the browser's built-in model via genaicode/browser.
   Loaded by index.html only where that model exists. */
import { createPageAgent } from "../vendor/genaicode-browser.js";
import { mountAsk, esc } from "../ask/ask.js";

const FX = window.FXLAB;
const ALL_STEPS = FX.EFFECTS.flatMap(e => e.steps.map((s, idx) => ({ effect: e, step: s, idx })));
const stepLine = (e, s) => `${s.id} (${e.en}, ${s.era}): "${s.en}". ${s.noteEn}`;
const STOP = new Set("the a an is are was were do does did how what where when why which who in on of to for and or it this that with i my me you can show effect step".split(" "));
const words = t => String(t).toLowerCase().match(/[a-z0-9-]{2,}/g)?.filter(w => !STOP.has(w)) ?? [];

const tools = [
  {
    name: "list_effects",
    description: "List all three FX Lab effects (Pixel-Art Gaussian Splats, Evolution of Fire, Evolution of Water) and their step ids.",
    run: () => FX.EFFECTS.map(e => `${e.id} ("${e.en}"): ` + e.steps.map(s => `${s.id} "${s.en}" (${s.era})`).join("; ")).join("\n"),
  },
  {
    name: "current_view",
    description: "The effect, step and split-screen mode currently running on screen.",
    run: () => {
      const c = FX.current();
      return `${stepLine(c.effect, c.step)} Split compare is ${c.split ? "ON" : "OFF"}.`;
    },
  },
  {
    name: "find_technique",
    description: "Find steps covering a specific rendering technique, e.g. \"bayer\", \"doom\", \"caustics\", \"fresnel\", \"navier-stokes\", \"splash\".",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: ({ query }) => {
      const q = words(query);
      if (!q.length) return "Give one or two key words.";
      const hits = ALL_STEPS.map(x => {
        const low = `${x.effect.id} ${x.effect.en} ${x.step.id} ${x.step.era} ${x.step.en} ${x.step.noteEn}`.toLowerCase();
        return { x, score: q.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0) };
      }).filter(h => h.score).sort((a, b) => b.score - a.score);
      return hits.length ? hits.slice(0, 4).map(h => stepLine(h.x.effect, h.x.step)).join("\n") : "No step matches. Try list_effects.";
    },
  },
  {
    name: "show_step",
    description: "Switch the screen to any step by its step id (e.g. S5, F2, F8, W4, W8).",
    inputSchema: { type: "object", properties: { id: { type: "string", enum: ALL_STEPS.map(x => x.step.id) } }, required: ["id"] },
    run: ({ id }) => FX.showByStepId(id) ? `Now showing ${stepLine(FX.current().effect, FX.current().step)}` : "No such step.",
  },
  {
    name: "set_split",
    description: "Turn the before/after split-screen comparison divider on or off.",
    inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    run: ({ enabled }) => { FX.setSplit(enabled); return `Split comparison is now ${enabled ? "ON" : "OFF"}.`; },
  },
  {
    name: "trigger_action",
    description: "Trigger the current step's interactive action (e.g. Sweep Sphere on F8, Drop Sphere on W8, Reveal Discs on S1, Wireframe on F3, Voxel Grid on F7).",
    run: () => FX.triggerAction() ? "Triggered the current step's interactive action." : "This step has no extra action button.",
  },
  {
    name: "about",
    description: "What FX Lab is, where the code lives and its licence.",
    run: () => [
      "FX Lab is an interactive WebGL2 sandbox by GamedevPL showcasing real-time graphics effects from short technical breakdowns.",
      "It includes Pixel-Art Gaussian Splats (5 shader steps), Evolution of Fire (8 eras from 1985 palette cycling to live 3D Navier-Stokes fluid), and Evolution of Water (8 eras from 1985 CLUT to live 128x128 shallow-water PDE and 3D splash).",
      "Plain JavaScript and raw WebGL2, zero external libraries. Source code: https://github.com/gamedevpl/fx-lab (MIT).",
    ].join("\n"),
  },
];

const agent = createPageAgent({
  name: "mascot",
  instructions: [
    "You are the gamedev.pl mascot on FX Lab, an interactive WebGL2 sandbox of graphics effects (Pixel-Art Gaussian Splats, Evolution of Fire, Evolution of Water).",
    "Use the tools for every fact. Never invent steps or techniques the tools do not return.",
    "When the user asks to see an effect or technique, call show_step (and trigger_action or set_split when helpful).",
    "Name steps by their id in backticks, like `S5`, `F8`, or `W8`.",
    "Answer in English, in one to four short sentences.",
    "If the tools do not answer the question, say you do not know.",
  ].join(" "),
  tools,
  nano: { language: "en", maxSteps: 4, ...(self.__fxLabModel ? { languageModel: self.__fxLabModel } : {}) },
});

const T = {
  en: {
    askOpen: "Ask the mascot", askTitle: "Ask about FX Lab", askNew: "New", askClose: "Close",
    askNote: "Runs on your browser's built-in model. Nothing leaves this page. It answers in English and can be wrong.",
    askPlaceholder: "How does palette cycling work?", askSend: "Ask", askStop: "Stop",
    askDownload: "Download the model (once)", askDownloading: "Downloading", askLoading: "Starting the model…",
    askHello: "Hi! Ask how any shader step works, or tell me which effect you want to inspect.",
    askThinking: "Thinking…",
    askChips: ["What am I looking at?", "Show me Doom fire", "Drop the sphere in water"],
    askTool: {
      list_effects: "effects", current_view: "this view", find_technique: "searching",
      show_step: "switching step", set_split: "split view", trigger_action: "running action", about: "about",
    },
  },
  pl: {
    askOpen: "Zapytaj maskotkę", askTitle: "Zapytaj o FX Lab", askNew: "Od nowa", askClose: "Zamknij",
    askNote: "Działa na modelu wbudowanym w przeglądarkę. Nic nie wychodzi z tej strony. Odpowiada po angielsku i czasem się myli.",
    askPlaceholder: "How does palette cycling work?", askSend: "Zapytaj", askStop: "Stop",
    askDownload: "Pobierz model (raz)", askDownloading: "Pobieranie", askLoading: "Uruchamiam model…",
    askHello: "Cześć! Zapytaj jak działa wybrany krok albo powiedz, który efekt chcesz zobaczyć.",
    askThinking: "Myślę…",
    askChips: ["What am I looking at?", "Show me Doom fire", "Drop the sphere in water"],
    askTool: {
      list_effects: "efekty", current_view: "ten widok", find_technique: "szukam",
      show_step: "przełączam krok", set_split: "podział", trigger_action: "akcja", about: "o stronie",
    },
  },
};

const stepIds = new Set(ALL_STEPS.map(x => x.step.id.toLowerCase()));
function rich(s) {
  return esc(s)
    .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`\n]+)`/g, (m, x) => stepIds.has(x.toLowerCase()) ? `<a href="#${x}" data-step="${x}">${x}</a>` : `<code>${x}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
}

const { redraw } = mountAsk(agent, {
  texts: () => T[FX.lang()],
  rich,
  onClick: t => {
    const a = t.closest("[data-step]");
    if (!a) return false;
    FX.showByStepId(a.dataset.step);
    return true;
  },
});

document.addEventListener("fxlab:lang", redraw);
document.addEventListener("click", ev => {
  if (ev.target.closest?.(".ask [data-step]")) ev.preventDefault();
});
