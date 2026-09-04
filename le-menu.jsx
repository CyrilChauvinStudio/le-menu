import React, { useState, useEffect, useMemo, useCallback } from "react";

// ------------------------------------------------------------------
// LE MENU — planificateur de la semaine
// Inspiration Le Fooding (associations osées) · orientation crétoise
// Déjeuners 2 pers. / Dîners 4 pers. · Lundi → Vendredi
// ------------------------------------------------------------------

const JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
const RAYONS = [
  "Fruits & légumes",
  "Poissonnerie",
  "Boucherie & charcuterie",
  "Crèmerie",
  "Épicerie",
  "Boulangerie",
  "Cave",
  "Autres",
];

const DEFAULT_SETTINGS = {
  v: 3,
  allergies: "",
  dislikes:
    "Ne jamais proposer d'omelette (mais toutes les autres préparations d'œufs sont adorées : brouillés, mollet, poché, à la coque, au plat…). Éviter le houmous et les tartinades / purées de pois chiches de type houmous, jugées trop pâteuses. Éviter les lentilles corail. Éviter les salsifis.",
  tempsMaxDej: 25,
  tempsMaxDiner: 45,
  portionsDej: 2,
  portionsDiner: 4,
  guestsProfiles: [
    { nom: "Willy", prefs: "mange de tout" },
    { nom: "Nel", prefs: "mange de tout" },
    {
      nom: "Tom",
      prefs:
        "n'aime pas les fruits sauf le raisin et la pastèque ; n'aime aucun fromage sauf fondu sur une pizza",
    },
  ],
};

// ---------- Stockage persistant (window.storage) --------------------
async function loadKey(key, fallback) {
  try {
    const r = await window.storage.get(key);
    return r && r.value ? JSON.parse(r.value) : fallback;
  } catch {
    return fallback;
  }
}
async function saveKey(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value));
  } catch {
    /* best effort */
  }
}

// ---------- Appel modèle --------------------------------------------
async function callClaude(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function tryParse(t) {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function extractJSON(text) {
  let t = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  let p = tryParse(t);
  if (p !== undefined) return p;

  const start = t.search(/[\[{]/);
  const endB = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  if (start >= 0 && endB > start) {
    p = tryParse(t.slice(start, endB + 1));
    if (p !== undefined) return p;
  }

  // Réparation d'une réponse tronquée : on recolle jusqu'au dernier objet complet.
  const body = start >= 0 ? t.slice(start) : t;
  const open = body.trim()[0];
  const lastObjClose = body.lastIndexOf("}");
  if (lastObjClose > 0) {
    const upto = body.slice(0, lastObjClose + 1);
    if (open === "[") {
      p = tryParse(upto + "]");
      if (p !== undefined) return p;
    }
    if (open === "{") {
      p = tryParse(upto);
      if (p !== undefined) return p;
    }
  }
  throw new Error("Réponse illisible");
}

// Relance automatique en cas d'échec (réseau ou JSON illisible).
async function withRetry(fn, attempts = 4, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- Concurrence ---------------------------------------------
async function runPool(items, worker, size = 4, onEach) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        const r = await worker(items[idx], idx);
        onEach && onEach(idx, r, null);
      } catch (e) {
        onEach && onEach(idx, null, e);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, next)
  );
}

// Cible la bonne recette d'une tâche (plat principal ou entrée).
function mealRefOf(working, t) {
  if (t.course === "entree") return working[t.i].diner.entree;
  return working[t.i][t.slot];
}

// ---------- Prompts --------------------------------------------------
const SYS_PLAN = `Tu es le chef d'un studio de recettes inspiré du Fooding : des associations de goûts audacieuses mais toujours réalistes et appétissantes. Tu conçois le menu d'un foyer dans le Sud de la France.
Règles absolues :
1) Esprit Le Fooding : associations surprenantes, produits de saison, herbes fraîches, agrumes, condiments, un twist par plat.
2) Orientation régime crétois : huile d'olive, légumes, légumineuses, céréales complètes, poisson, herbes, fruits ; peu de viande rouge, peu de sucre.
3) Ingrédients faciles à trouver en supermarché ou au marché dans le Sud de la France.
4) Cuisine rapide et simple : AUCUNE cuisson longue (pas de mijotage ni braisage de plusieurs heures, pas de basse température prolongée).
5) Variété maximale sur la semaine : protéines, légumes, influences et textures différents chaque jour.
6) Chaque repas doit être ÉQUILIBRÉ : une source de protéines (poisson, œuf, légumineuse, volaille…), des légumes, et une source de féculents / céréales complètes / légumineuses.
Tu réponds UNIQUEMENT en JSON valide, sans aucun texte ni balise Markdown autour.`;

const SYS_DETAIL = `Tu es le chef d'un studio de recettes inspiré du Fooding. Tu écris une recette précise, rapide et facile à réaliser, orientation régime crétois, ingrédients faciles à trouver dans le Sud de la France, aucune cuisson longue. Le repas doit être équilibré (protéines + légumes + féculents/légumineuses). Étapes courtes, concrètes, dans l'ordre.
Tu réponds UNIQUEMENT en JSON valide, sans aucun texte ni balise Markdown autour.`;

function contraintesFoyer(settings) {
  const parts = [];
  if (settings.allergies && settings.allergies.trim())
    parts.push(`ALLERGIES / à bannir absolument : ${settings.allergies.trim()}`);
  if (settings.dislikes && settings.dislikes.trim())
    parts.push(`N'aime pas : ${settings.dislikes.trim()}`);
  return parts.join(". ");
}

// Apprentissage : ce que le foyer a aimé (top) ou raté (bof) au fil du temps.
let LEARNED = "";
function setLearned(txt) {
  LEARNED = txt || "";
}
function buildLearned(feedback) {
  const entries = Object.entries(feedback || {});
  const tops = entries
    .filter(([, v]) => v && v.note === "top")
    .map(([t]) => t)
    .slice(-14);
  const bofs = entries
    .filter(([, v]) => v && v.note === "bof")
    .map(([t]) => t)
    .slice(-14);
  let s = "";
  if (tops.length)
    s += ` Plats particulièrement appréciés par le passé (garde le même esprit, ces associations et ce style, sans les copier à l'identique) : ${tops.join(
      " ; "
    )}.`;
  if (bofs.length)
    s += ` Plats ratés à NE PAS reproposer ni imiter : ${bofs.join(" ; ")}.`;
  return s;
}
function bofTitles(feedback) {
  return Object.entries(feedback || {})
    .filter(([, v]) => v && v.note === "bof")
    .map(([t]) => t);
}

async function planMeals(type, portions, settings, tempsMax, avoid, guestsNote) {
  const user = `Propose 5 ${type}s distincts, un par jour : Lundi, Mardi, Mercredi, Jeudi, Vendredi (dans cet ordre), pour ${portions} personnes.
Temps de préparation + cuisson : ${tempsMax} minutes maximum par plat.
${contraintesFoyer(settings)}
${guestsNote || ""}${LEARNED}
À NE PAS reproposer cette fois : ${avoid.length ? avoid.join(" ; ") : "aucun"}.
Réponds en JSON, exactement 5 éléments :
[{"jour":"Lundi","titre":"nom du plat","twist":"une phrase courte sur l'association de goûts audacieuse"}]`;
  const raw = await callClaude(SYS_PLAN, user);
  const arr = extractJSON(raw);
  return JOURS.map((j) => {
    const found = (arr || []).find(
      (x) => (x.jour || "").toLowerCase() === j.toLowerCase()
    );
    return found || arr[JOURS.indexOf(j)] || { jour: j, titre: "—", twist: "" };
  });
}

async function planOne(type, jour, portions, settings, tempsMax, avoid, guestsNote) {
  const user = `Propose 1 ${type} pour le ${jour}, pour ${portions} personnes, différent de tout ce qui suit.
Temps max : ${tempsMax} minutes. ${contraintesFoyer(settings)} ${guestsNote || ""}${LEARNED}
À NE PAS reproposer : ${avoid.length ? avoid.join(" ; ") : "aucun"}.
Réponds en JSON : {"jour":"${jour}","titre":"...","twist":"..."}`;
  const raw = await callClaude(SYS_PLAN, user);
  const o = extractJSON(raw);
  return Array.isArray(o) ? o[0] : o;
}

async function detailMeal(type, titre, twist, portions, settings, tempsMax, guestsNote) {
  const estEntree = /entr[ée]e/i.test(type);
  const user = `Recette détaillée pour : "${titre}". Idée / twist : ${twist}.
Type : ${type}. Pour ${portions} personnes. Temps max : ${tempsMax} minutes.
${estEntree ? "C'est une ENTRÉE : portion d'entrée, plutôt légère et simple, qui ouvre le repas (pas besoin qu'elle soit un repas complet équilibré à elle seule)." : ""}
${contraintesFoyer(settings)} ${guestsNote || ""}
Réponds en JSON strict, COMPACT :
{"tempsMinutes":25,"difficulte":"facile","ingredients":[{"nom":"...","quantite":"200 g","rayon":"un de : Fruits & légumes | Poissonnerie | Boucherie & charcuterie | Crèmerie | Épicerie | Boulangerie | Cave | Autres"}],"etapes":["étape courte"]}
Maximum 9 ingrédients essentiels et 6 étapes, une phrase courte chacune. Quantités brèves (ex : "200 g", "2 c. à s.") pour ${portions} personnes. Sois concis, ne dépasse pas la limite.`;
  const raw = await callClaude(SYS_DETAIL, user);
  return extractJSON(raw);
}

// ---------- Utilitaires date ----------------------------------------
function prochainLundi() {
  const d = new Date();
  const delta = (8 - d.getDay()) % 7 || 7; // toujours le lundi suivant
  d.setDate(d.getDate() + delta);
  return d;
}
function labelSemaine() {
  const d = prochainLundi();
  return `Semaine du ${d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
  })}`;
}

// ====================================================================
export default function App() {
  const [view, setView] = useState("menu"); // menu | courses | reglages
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [history, setHistory] = useState([]); // titres déjà proposés
  const [plan, setPlan] = useState(null); // [{jour, dejeuner, diner}]
  const [guests, setGuests] = useState({}); // {Lundi:{on,couverts,prefs}}
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, msg: "" });
  const [erreur, setErreur] = useState("");
  const [coches, setCoches] = useState({});
  const [feedback, setFeedback] = useState({}); // {titre: {note, twist, ts}}
  const [loaded, setLoaded] = useState(false);

  // Chargement initial
  useEffect(() => {
    (async () => {
      const [s, h, w] = await Promise.all([
        loadKey("lemenu:settings", DEFAULT_SETTINGS),
        loadKey("lemenu:history", []),
        loadKey("lemenu:week", null),
      ]);
      const fb = await loadKey("lemenu:feedback", {});
      const merged = { ...DEFAULT_SETTINGS, ...s };
      if (!s || s.v !== DEFAULT_SETTINGS.v) {
        if (!merged.dislikes || !merged.dislikes.trim()) {
          merged.dislikes = DEFAULT_SETTINGS.dislikes;
        } else {
          const ajouts = [];
          if (!/omelette/i.test(merged.dislikes))
            ajouts.push(
              "Ne jamais proposer d'omelette (les autres préparations d'œufs sont adorées)."
            );
          if (!/houmous|pois chiches/i.test(merged.dislikes))
            ajouts.push(
              "Éviter le houmous et les purées de pois chiches type houmous."
            );
          if (!/lentilles?\s+corail/i.test(merged.dislikes))
            ajouts.push("Éviter les lentilles corail.");
          if (!/salsifis/i.test(merged.dislikes))
            ajouts.push("Éviter les salsifis.");
          if (ajouts.length)
            merged.dislikes = merged.dislikes.trim() + " " + ajouts.join(" ");
        }
        merged.v = DEFAULT_SETTINGS.v;
      }
      setSettings(merged);
      setHistory(h || []);
      setFeedback(fb || {});
      if (w) {
        setPlan(w.plan || null);
        setGuests(w.guests || {});
        setCoches(w.coches || {});
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (loaded) saveKey("lemenu:settings", settings);
  }, [settings, loaded]);

  const persistWeek = useCallback(
    (nextPlan, nextGuests, nextCoches) => {
      saveKey("lemenu:week", {
        plan: nextPlan,
        guests: nextGuests,
        coches: nextCoches,
        label: labelSemaine(),
      });
    },
    []
  );

  function noterPlat(titre, note, twist) {
    if (!titre) return;
    const next = { ...feedback };
    if (next[titre] && next[titre].note === note) {
      delete next[titre]; // re-cliquer la même note l'enlève
    } else {
      next[titre] = { note, twist: twist || "", ts: Date.now() };
    }
    // garder les 120 plus récents
    const keys = Object.keys(next);
    if (keys.length > 120) {
      keys
        .sort((a, b) => (next[a].ts || 0) - (next[b].ts || 0))
        .slice(0, keys.length - 120)
        .forEach((k) => delete next[k]);
    }
    setFeedback(next);
    saveKey("lemenu:feedback", next);
  }

  function guestsNoteFor(jour) {
    const g = guests[jour];
    if (!g || !g.on) return "";
    const profils = settings.guestsProfiles || [];
    const nomsInvites = g.invites || [];
    const detailInvites = nomsInvites
      .map((nom) => {
        const p = profils.find((x) => x.nom === nom);
        return p && p.prefs ? `${nom} (${p.prefs})` : nom;
      })
      .join(", ");
    let note = `Dîner avec invités le ${jour} (${g.couverts || 4} couverts).`;
    if (detailInvites) note += ` Convives : ${detailInvites}.`;
    if (g.prefs) note += ` Autres préférences : ${g.prefs}.`;
    note +=
      " Respecte impérativement les goûts de chaque convive dans le choix des ingrédients.";
    return note;
  }
  function portionsDinerFor(jour) {
    const g = guests[jour];
    return g && g.on && g.couverts ? Number(g.couverts) : settings.portionsDiner;
  }

  // ---------------- Génération complète ----------------
  async function genererSemaine() {
    setErreur("");
    setGenerating(true);
    setProgress({ done: 0, total: 10, msg: "On imagine le menu…" });
    try {
      setLearned(buildLearned(feedback));
      const avoid = [...history, ...bofTitles(feedback)];
      const guestsGlobal = JOURS.map(guestsNoteFor).filter(Boolean).join(" ");

      // 1) Plans
      const lunchPlan = await withRetry(() =>
        planMeals(
          "déjeuner",
          settings.portionsDej,
          settings,
          settings.tempsMaxDej,
          avoid,
          ""
        )
      );
      setProgress((p) => ({ ...p, msg: "Les déjeuners sont prêts…" }));
      const lunchTitles = lunchPlan.map((x) => x.titre);
      const paires = JOURS.map((j, i) => `${j} midi = ${lunchPlan[i].titre}`).join(
        " ; "
      );
      const noteJournee = `RÈGLE DE JOURNÉE : chaque dîner doit éviter la protéine et l'ingrédient principal du déjeuner du même jour — jamais poisson midi ET soir, jamais œufs midi ET soir, etc. Déjeuners prévus : ${paires}.`;
      const dinnerPlan = await withRetry(() =>
        planMeals(
          "dîner",
          settings.portionsDiner,
          settings,
          settings.tempsMaxDiner,
          [...avoid, ...lunchTitles],
          `${guestsGlobal} ${noteJournee}`
        )
      );
      setProgress((p) => ({ ...p, msg: "On rédige les recettes…" }));

      // Entrées : uniquement les dîners avec invités
      const entreePlans = {};
      const joursInvites = JOURS.map((j, i) => ({ j, i })).filter(
        (x) => guests[x.j] && guests[x.j].on
      );
      const avoidEntrees = [
        ...avoid,
        ...lunchTitles,
        ...dinnerPlan.map((x) => x.titre),
      ];
      for (const { j, i } of joursInvites) {
        try {
          const noteEntree = `${guestsNoteFor(
            j
          )} L'entrée doit utiliser une protéine/un ingrédient principal différent du déjeuner (${lunchPlan[i].titre}) et du plat du soir (${dinnerPlan[i].titre}).`;
          const idea = await withRetry(() =>
            planOne(
              "entrée",
              j,
              portionsDinerFor(j),
              settings,
              settings.tempsMaxDiner,
              avoidEntrees,
              noteEntree
            )
          );
          entreePlans[i] = idea;
          avoidEntrees.push(idea.titre);
        } catch {
          entreePlans[i] = { titre: "Entrée", twist: "" };
        }
      }

      // 2) Squelette
      const skeleton = JOURS.map((j, i) => ({
        jour: j,
        dejeuner: {
          ...lunchPlan[i],
          portions: settings.portionsDej,
          status: "loading",
          details: null,
        },
        diner: {
          ...dinnerPlan[i],
          portions: portionsDinerFor(j),
          status: "loading",
          details: null,
          entree: entreePlans[i]
            ? {
                ...entreePlans[i],
                portions: portionsDinerFor(j),
                status: "loading",
                details: null,
              }
            : undefined,
        },
      }));
      setPlan(skeleton);

      // 3) Détails en parallèle
      const tasks = [];
      JOURS.forEach((j, i) => {
        tasks.push({ i, slot: "dejeuner", course: "main", type: "déjeuner", tmax: settings.tempsMaxDej, gnote: "" });
        if (entreePlans[i])
          tasks.push({ i, slot: "diner", course: "entree", type: "entrée", tmax: settings.tempsMaxDiner, gnote: guestsNoteFor(j) });
        tasks.push({ i, slot: "diner", course: "main", type: "dîner", tmax: settings.tempsMaxDiner, gnote: guestsNoteFor(j) });
      });
      const total = tasks.length;

      let done = 0;
      const working = skeleton.map((d) => ({
        ...d,
        dejeuner: { ...d.dejeuner },
        diner: { ...d.diner },
      }));

      await runPool(
        tasks,
        async (t) => {
          const meal = mealRefOf(working, t);
          const det = await withRetry(() =>
            detailMeal(
              t.type,
              meal.titre,
              meal.twist,
              meal.portions,
              settings,
              t.tmax,
              t.gnote
            )
          );
          return { t, det };
        },
        4,
        (idx, r, err) => {
          const t = tasks[idx];
          const ref = mealRefOf(working, t);
          if (r && r.det) {
            ref.details = r.det;
            ref.status = "done";
            done += 1;
          } else {
            ref.status = "error";
          }
          setProgress({ done, total, msg: "On rédige les recettes…" });
          setPlan(
            working.map((d) => ({
              ...d,
              dejeuner: { ...d.dejeuner },
              diner: { ...d.diner },
            }))
          );
        }
      );

      // 3bis) Réparation automatique des recettes qui n'ont pas abouti
      for (let pass = 0; pass < 2; pass++) {
        const restants = tasks.filter(
          (t) => mealRefOf(working, t).status === "error"
        );
        if (!restants.length) break;
        setProgress((p) => ({
          ...p,
          msg: "On réessaie les recettes manquantes…",
        }));
        working.forEach((d) => {
          ["dejeuner", "diner"].forEach((s) => {
            if (d[s].status === "error") d[s].status = "loading";
          });
          if (d.diner.entree && d.diner.entree.status === "error")
            d.diner.entree.status = "loading";
        });
        setPlan(
          working.map((d) => ({
            ...d,
            dejeuner: { ...d.dejeuner },
            diner: { ...d.diner },
          }))
        );
        await runPool(
          restants,
          async (t) => {
            const meal = mealRefOf(working, t);
            const det = await withRetry(() =>
              detailMeal(
                t.type,
                meal.titre,
                meal.twist,
                meal.portions,
                settings,
                t.tmax,
                t.gnote
              )
            );
            return { t, det };
          },
          3,
          (idx, r) => {
            const t = restants[idx];
            const ref = mealRefOf(working, t);
            if (r && r.det) {
              ref.details = r.det;
              ref.status = "done";
              done += 1;
            } else {
              ref.status = "error";
            }
            setProgress({
              done,
              total,
              msg: "On réessaie les recettes manquantes…",
            });
            setPlan(
              working.map((d) => ({
                ...d,
                dejeuner: { ...d.dejeuner },
                diner: { ...d.diner },
              }))
            );
          }
        );
      }

      // 4) Historique + persistance
      const nouveauxTitres = [
        ...lunchPlan.map((x) => x.titre),
        ...dinnerPlan.map((x) => x.titre),
        ...Object.values(entreePlans).map((x) => x.titre),
      ].filter((x) => x && x !== "—" && x !== "Entrée");
      const nextHist = [...nouveauxTitres, ...history].slice(0, 50);
      setHistory(nextHist);
      saveKey("lemenu:history", nextHist);
      setCoches({});
      persistWeek(working, guests, {});
      setPlan(working);
    } catch (e) {
      setErreur(
        "La génération a échoué. Vérifie ta connexion et réessaie — rien n'est perdu."
      );
    } finally {
      setGenerating(false);
      setProgress({ done: 0, total: 0, msg: "" });
    }
  }

  // ---------------- Regénérer un plat ----------------
  async function regenererPlat(dayIndex, slot, course = "main") {
    if (!plan) return;
    const jour = JOURS[dayIndex];
    const estEntree = course === "entree";
    const type = estEntree
      ? "entrée"
      : slot === "dejeuner"
      ? "déjeuner"
      : "dîner";
    const tmax = slot === "dejeuner" ? settings.tempsMaxDej : settings.tempsMaxDiner;
    const portions =
      slot === "dejeuner" ? settings.portionsDej : portionsDinerFor(jour);
    let gnote = slot === "dejeuner" ? "" : guestsNoteFor(jour);

    // Éviter l'ingrédient principal de l'autre repas du même jour.
    const jourData = plan[dayIndex];
    if (estEntree) {
      gnote += ` L'entrée doit utiliser une protéine/un ingrédient principal différent du déjeuner (${jourData.dejeuner.titre}) et du plat du soir (${jourData.diner.titre}).`;
    } else if (slot === "diner") {
      gnote += ` Éviter la protéine et l'ingrédient principal du déjeuner du même jour (${jourData.dejeuner.titre}).`;
    } else if (slot === "dejeuner") {
      gnote += ` Éviter la protéine et l'ingrédient principal du dîner du même jour (${jourData.diner.titre}).`;
    }

    const current = plan.map((d) => ({
      ...d,
      dejeuner: { ...d.dejeuner },
      diner: {
        ...d.diner,
        entree: d.diner.entree ? { ...d.diner.entree } : undefined,
      },
    }));
    const getCible = () =>
      estEntree ? current[dayIndex].diner.entree : current[dayIndex][slot];
    const setCible = (val) => {
      if (estEntree) current[dayIndex].diner.entree = val;
      else current[dayIndex][slot] = val;
    };
    if (estEntree && !current[dayIndex].diner.entree) {
      current[dayIndex].diner.entree = {
        titre: "",
        twist: "",
        portions,
        status: "loading",
        details: null,
      };
    }
    if (!getCible()) return;
    const ancien = getCible().titre;
    setCible({ ...getCible(), status: "loading" });
    setPlan(current.map((d) => ({ ...d })));

    try {
      setLearned(buildLearned(feedback));
      const tousTitres = [];
      current.forEach((d) => {
        tousTitres.push(d.dejeuner.titre, d.diner.titre);
        if (d.diner.entree) tousTitres.push(d.diner.entree.titre);
      });
      const avoid = [...tousTitres, ...history, ...bofTitles(feedback)].filter(
        Boolean
      );
      const idea = await withRetry(() =>
        planOne(type, jour, portions, settings, tmax, avoid, gnote)
      );
      const det = await withRetry(() =>
        detailMeal(type, idea.titre, idea.twist, portions, settings, tmax, gnote)
      );
      setCible({ ...idea, portions, details: det, status: "done" });
      setPlan(current.map((d) => ({ ...d })));
      const nextHist = [idea.titre, ...history.filter((x) => x !== ancien)].slice(
        0,
        50
      );
      setHistory(nextHist);
      saveKey("lemenu:history", nextHist);
      persistWeek(current, guests, coches);
    } catch {
      setCible({ ...getCible(), status: "error" });
      setPlan(current.map((d) => ({ ...d })));
    }
  }

  // ---------------- Liste de courses ----------------
  const courses = useMemo(() => {
    if (!plan) return {};
    const map = {};
    const ajouterDetails = (det) => {
      if (!det || !Array.isArray(det.ingredients)) return;
      det.ingredients.forEach((ing) => {
        const rayon = RAYONS.includes(ing.rayon) ? ing.rayon : "Autres";
        const nom = (ing.nom || "").trim();
        if (!nom) return;
        const key = nom.toLowerCase();
        if (!map[rayon]) map[rayon] = {};
        if (!map[rayon][key]) map[rayon][key] = { nom, quantites: [] };
        if (ing.quantite) map[rayon][key].quantites.push(ing.quantite);
      });
    };
    plan.forEach((d) => {
      ajouterDetails(d.dejeuner.details);
      ajouterDetails(d.diner.details);
      if (d.diner.entree) ajouterDetails(d.diner.entree.details);
    });
    return map;
  }, [plan]);

  function toggleCoche(rayon, nom) {
    const key = `${rayon}|${nom.toLowerCase()}`;
    const next = { ...coches, [key]: !coches[key] };
    setCoches(next);
    persistWeek(plan, guests, next);
  }

  const styles = <StyleBlock />;

  // ---------------- Rendu ----------------
  return (
    <div className="lm-root">
      {styles}
      <header className="lm-header">
        <div className="lm-brand">
          <span className="lm-brand-le">le</span>
          <span className="lm-brand-menu">menu</span>
        </div>
        <nav className="lm-nav">
          <button
            className={view === "menu" ? "on" : ""}
            onClick={() => setView("menu")}
          >
            La semaine
          </button>
          <button
            className={view === "courses" ? "on" : ""}
            onClick={() => setView("courses")}
          >
            Les courses
          </button>
          <button
            className={view === "reglages" ? "on" : ""}
            onClick={() => setView("reglages")}
          >
            Réglages
          </button>
        </nav>
      </header>

      <main className="lm-main">
        {view === "menu" && (
          <MenuView
            plan={plan}
            generating={generating}
            progress={progress}
            erreur={erreur}
            onGenerer={genererSemaine}
            onRegenerer={regenererPlat}
            guests={guests}
            setGuests={(g) => {
              setGuests(g);
              persistWeek(plan, g, coches);
            }}
            guestsOpen={guestsOpen}
            setGuestsOpen={setGuestsOpen}
            settings={settings}
            feedback={feedback}
            onRate={noterPlat}
          />
        )}
        {view === "courses" && (
          <CoursesView
            courses={courses}
            coches={coches}
            onToggle={toggleCoche}
            hasPlan={!!plan}
          />
        )}
        {view === "reglages" && (
          <ReglagesView settings={settings} setSettings={setSettings} />
        )}
      </main>
    </div>
  );
}

// ---------------- Vue : La semaine ----------------
function MenuView({
  plan,
  generating,
  progress,
  erreur,
  onGenerer,
  onRegenerer,
  guests,
  setGuests,
  guestsOpen,
  setGuestsOpen,
  settings,
  feedback,
  onRate,
}) {
  const vide = !plan;

  return (
    <div>
      <div className="lm-weekbar">
        <div>
          <p className="lm-eyebrow">Rituel du vendredi soir</p>
          <h1 className="lm-title">{labelSemaine()}</h1>
        </div>
        <button
          className="lm-cta"
          onClick={onGenerer}
          disabled={generating}
        >
          {generating
            ? "En cuisine…"
            : vide
            ? "Générer la semaine"
            : "Refaire la semaine"}
        </button>
      </div>

      {/* Invités */}
      <div className="lm-guests">
        <button
          className="lm-guests-toggle"
          onClick={() => setGuestsOpen(!guestsOpen)}
        >
          {guestsOpen ? "Masquer les invités" : "Des invités cette semaine ?"}
        </button>
        {guestsOpen && (
          <div className="lm-guests-body">
            <p className="lm-hint">
              Un dîner à part ? Indique le nombre de couverts et ce que tes
              invités n'aiment pas — la recette du soir s'adaptera.
            </p>
            {JOURS.map((j) => {
              const g = guests[j] || {};
              const profils = settings.guestsProfiles || [];
              const invites = g.invites || [];
              const toggleInvite = (nom) => {
                const next = invites.includes(nom)
                  ? invites.filter((x) => x !== nom)
                  : [...invites, nom];
                setGuests({ ...guests, [j]: { ...g, invites: next } });
              };
              return (
                <div key={j} className="lm-guest-row">
                  <div className="lm-guest-head">
                    <label className="lm-check">
                      <input
                        type="checkbox"
                        checked={!!g.on}
                        onChange={(e) =>
                          setGuests({
                            ...guests,
                            [j]: {
                              ...g,
                              on: e.target.checked,
                              couverts: g.couverts || 4,
                            },
                          })
                        }
                      />
                      <span>{j}</span>
                    </label>
                    {g.on && (
                      <label className="lm-couverts">
                        <input
                          className="lm-num"
                          type="number"
                          min="2"
                          max="20"
                          value={g.couverts || 4}
                          onChange={(e) =>
                            setGuests({
                              ...guests,
                              [j]: { ...g, couverts: e.target.value },
                            })
                          }
                          aria-label={"Couverts " + j}
                        />
                        <span>couv.</span>
                      </label>
                    )}
                  </div>
                  {g.on && (
                    <div className="lm-guest-detail">
                      <div className="lm-chips">
                        {profils.map((p) => (
                          <button
                            key={p.nom}
                            type="button"
                            className={
                              "lm-chip" +
                              (invites.includes(p.nom) ? " on" : "")
                            }
                            onClick={() => toggleInvite(p.nom)}
                            title={p.prefs}
                          >
                            {p.nom}
                          </button>
                        ))}
                      </div>
                      <input
                        className="lm-prefs"
                        type="text"
                        placeholder="Autre invité / contrainte ponctuelle…"
                        value={g.prefs || ""}
                        onChange={(e) =>
                          setGuests({
                            ...guests,
                            [j]: { ...g, prefs: e.target.value },
                          })
                        }
                        aria-label={"Préférences " + j}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {erreur && <div className="lm-error">{erreur}</div>}

      {generating && progress.total > 0 && (
        <div className="lm-progress">
          <div className="lm-progress-bar">
            <div
              className="lm-progress-fill"
              style={{
                width: `${Math.round((progress.done / progress.total) * 100)}%`,
              }}
            />
          </div>
          <p>
            {progress.msg} {progress.done}/{progress.total} plats
          </p>
        </div>
      )}

      {vide && !generating && (
        <div className="lm-empty">
          <p className="lm-empty-big">Qu'est-ce qu'on mange cette semaine ?</p>
          <p className="lm-empty-sub">
            Cinq déjeuners pour deux, cinq dîners pour quatre. Des goûts qui
            osent, des ingrédients qu'on trouve, rien qui cuit pendant des
            heures. Appuie sur « Générer la semaine ».
          </p>
        </div>
      )}

      {plan &&
        plan.map((d, i) => (
          <section key={d.jour} className="lm-day">
            <h2 className="lm-dayname">{d.jour}</h2>
            <div className="lm-meals">
              <MealCard
                slot="dejeuner"
                label="Déjeuner"
                couverts={d.dejeuner.portions}
                meal={d.dejeuner}
                feedback={feedback}
                onRate={onRate}
                onRegen={(course) => onRegenerer(i, "dejeuner", course)}
              />
              <MealCard
                slot="diner"
                label="Dîner"
                couverts={d.diner.portions}
                meal={d.diner}
                attendsEntree={!!(guests[d.jour] && guests[d.jour].on)}
                feedback={feedback}
                onRate={onRate}
                onRegen={(course) => onRegenerer(i, "diner", course)}
              />
            </div>
          </section>
        ))}
    </div>
  );
}

function CourseBlock({ meal, onRegen, sousTitre, note, onRate }) {
  const [open, setOpen] = useState(false);
  const det = meal.details;
  const loading = meal.status === "loading";
  const error = meal.status === "error";

  return (
    <div className="lm-course">
      <div className="lm-course-head">
        <span className="lm-course-label-wrap">
          {sousTitre && <span className="lm-course-label">{sousTitre}</span>}
        </span>
        <span className="lm-course-tools">
          {det && (
            <span className="lm-badges">
              <span className="lm-badge lm-badge-temps">
                {det.tempsMinutes} min
              </span>
              <span className="lm-badge">{det.difficulte}</span>
            </span>
          )}
          {det && (
            <button
              className="lm-swap"
              onClick={onRegen}
              title="Changer ce plat"
              aria-label="Changer ce plat"
            >
              ↻ Changer
            </button>
          )}
        </span>
      </div>

      <h3 className="lm-plat">{meal.titre}</h3>
      {meal.twist && <p className="lm-twist">{meal.twist}</p>}

      {loading && <p className="lm-loading">On rédige la recette…</p>}
      {error && (
        <div className="lm-card-error">
          <span>La recette n'a pas abouti.</span>
          <button className="lm-mini" onClick={onRegen}>
            Réessayer
          </button>
        </div>
      )}

      {det && (
        <>
          <button className="lm-open" onClick={() => setOpen(!open)}>
            {open ? "Replier la recette" : "Voir la recette"}
          </button>
          {open && (
            <div className="lm-recette">
              <h4>Ingrédients</h4>
              <ul className="lm-ing">
                {(det.ingredients || []).map((ing, k) => (
                  <li key={k}>
                    <span className="lm-ing-nom">{ing.nom}</span>
                    {ing.quantite && (
                      <span className="lm-ing-q"> — {ing.quantite}</span>
                    )}
                  </li>
                ))}
              </ul>
              <h4>Préparation</h4>
              <ol className="lm-steps">
                {(det.etapes || []).map((s, k) => (
                  <li key={k}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          <div className="lm-rate">
            <span className="lm-rate-q">Testé&nbsp;?</span>
            {[
              ["bof", "Bof"],
              ["moyen", "Moyen"],
              ["top", "Top"],
            ].map(([val, lab]) => (
              <button
                key={val}
                className={
                  "lm-rate-btn lm-rate-" + val + (note === val ? " on" : "")
                }
                onClick={() => onRate && onRate(val)}
              >
                {lab}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MealCard({ slot, label, couverts, meal, onRegen, attendsEntree, feedback, onRate }) {
  const hasEntree = !!meal.entree;
  const fb = feedback || {};
  const noteFor = (t) => (fb[t] ? fb[t].note : null);
  return (
    <article className={`lm-card lm-card-${slot}`}>
      <div className="lm-card-top">
        <span className="lm-meal-label">
          {label} · {couverts} couv.
          {hasEntree && <span className="lm-two-courses"> · entrée + plat</span>}
        </span>
      </div>
      {hasEntree ? (
        <>
          <CourseBlock
            meal={meal.entree}
            sousTitre="Entrée"
            onRegen={() => onRegen("entree")}
            note={noteFor(meal.entree.titre)}
            onRate={(n) => onRate(meal.entree.titre, n, meal.entree.twist)}
          />
          <div className="lm-course-sep" />
          <CourseBlock
            meal={meal}
            sousTitre="Plat"
            onRegen={() => onRegen("main")}
            note={noteFor(meal.titre)}
            onRate={(n) => onRate(meal.titre, n, meal.twist)}
          />
        </>
      ) : (
        <>
          {attendsEntree && (
            <button
              className="lm-add-entree"
              onClick={() => onRegen("entree")}
            >
              + Ajouter une entrée
            </button>
          )}
          <CourseBlock
            meal={meal}
            sousTitre={attendsEntree ? "Plat" : undefined}
            onRegen={() => onRegen("main")}
            note={noteFor(meal.titre)}
            onRate={(n) => onRate(meal.titre, n, meal.twist)}
          />
        </>
      )}
    </article>
  );
}

// ---------------- Vue : Les courses ----------------
function CoursesView({ courses, coches, onToggle, hasPlan }) {
  const rayonsRemplis = RAYONS.filter(
    (r) => courses[r] && Object.keys(courses[r]).length
  );

  if (!hasPlan)
    return (
      <div className="lm-empty">
        <p className="lm-empty-big">Pas encore de courses.</p>
        <p className="lm-empty-sub">
          Génère d'abord la semaine : la liste se remplit toute seule, classée
          par rayon.
        </p>
      </div>
    );

  return (
    <div className="lm-courses">
      <h1 className="lm-title">La liste de courses</h1>
      <p className="lm-hint">Coche au fur et à mesure — c'est gardé en mémoire.</p>
      {rayonsRemplis.map((r) => (
        <section key={r} className="lm-rayon">
          <h2 className="lm-rayon-titre">{r}</h2>
          <ul>
            {Object.values(courses[r]).map((item) => {
              const key = `${r}|${item.nom.toLowerCase()}`;
              const done = !!coches[key];
              return (
                <li key={key} className={done ? "done" : ""}>
                  <label className="lm-check">
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={() => onToggle(r, item.nom)}
                    />
                    <span className="lm-course-nom">{item.nom}</span>
                  </label>
                  {item.quantites.length > 0 && (
                    <span className="lm-course-q">
                      {[...new Set(item.quantites)].join(" + ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------------- Vue : Réglages ----------------
function ReglagesView({ settings, setSettings }) {
  const set = (patch) => setSettings({ ...settings, ...patch });
  const guestsP = settings.guestsProfiles || [];
  const updateGuest = (i, patch) =>
    set({ guestsProfiles: guestsP.map((g, k) => (k === i ? { ...g, ...patch } : g)) });
  const removeGuest = (i) =>
    set({ guestsProfiles: guestsP.filter((_, k) => k !== i) });
  const addGuest = () =>
    set({ guestsProfiles: [...guestsP, { nom: "", prefs: "" }] });
  return (
    <div className="lm-reglages">
      <h1 className="lm-title">Réglages du foyer</h1>

      <div className="lm-field lm-field-alert">
        <label htmlFor="allergies">Allergies / à bannir absolument</label>
        <textarea
          id="allergies"
          rows="2"
          placeholder="ex : arachides, crustacés…"
          value={settings.allergies}
          onChange={(e) => set({ allergies: e.target.value })}
        />
        <p className="lm-hint">Toujours respecté, pour chaque plat.</p>
      </div>

      <div className="lm-field">
        <label htmlFor="dislikes">Ce qu'on n'aime pas</label>
        <textarea
          id="dislikes"
          rows="2"
          placeholder="ex : coriandre, foie, plats trop sucrés…"
          value={settings.dislikes}
          onChange={(e) => set({ dislikes: e.target.value })}
        />
      </div>

      <div className="lm-grid2">
        <div className="lm-field">
          <label htmlFor="td">Temps max déjeuner (min)</label>
          <input
            id="td"
            type="number"
            min="10"
            max="90"
            value={settings.tempsMaxDej}
            onChange={(e) => set({ tempsMaxDej: Number(e.target.value) })}
          />
        </div>
        <div className="lm-field">
          <label htmlFor="tn">Temps max dîner (min)</label>
          <input
            id="tn"
            type="number"
            min="10"
            max="90"
            value={settings.tempsMaxDiner}
            onChange={(e) => set({ tempsMaxDiner: Number(e.target.value) })}
          />
        </div>
        <div className="lm-field">
          <label htmlFor="pd">Couverts déjeuner</label>
          <input
            id="pd"
            type="number"
            min="1"
            max="12"
            value={settings.portionsDej}
            onChange={(e) => set({ portionsDej: Number(e.target.value) })}
          />
        </div>
        <div className="lm-field">
          <label htmlFor="pn">Couverts dîner</label>
          <input
            id="pn"
            type="number"
            min="1"
            max="12"
            value={settings.portionsDiner}
            onChange={(e) => set({ portionsDiner: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="lm-field">
        <label>Invités récurrents</label>
        <p className="lm-hint">
          Leurs goûts sont réutilisés dès que tu les coches pour un dîner, sur
          l'onglet « La semaine ».
        </p>
        {guestsP.map((p, i) => (
          <div key={i} className="lm-guest-edit">
            <input
              className="lm-num-nom"
              type="text"
              value={p.nom}
              placeholder="Nom"
              onChange={(e) => updateGuest(i, { nom: e.target.value })}
              aria-label="Nom de l'invité"
            />
            <input
              className="lm-prefs"
              type="text"
              value={p.prefs}
              placeholder="ce qu'il/elle aime ou n'aime pas…"
              onChange={(e) => updateGuest(i, { prefs: e.target.value })}
              aria-label="Préférences de l'invité"
            />
            <button
              className="lm-mini"
              type="button"
              onClick={() => removeGuest(i)}
            >
              retirer
            </button>
          </div>
        ))}
        <button className="lm-open" type="button" onClick={addGuest}>
          + Ajouter un invité
        </button>
      </div>

      <p className="lm-hint">
        Orientation crétoise, esprit Le Fooding et repas équilibré chaque jour
        sont appliqués d'office.
      </p>
    </div>
  );
}

// ---------------- Styles ----------------
function StyleBlock() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Archivo:wght@400;500;600;700&display=swap');

.lm-root{
  --paper:#EDEEE1;
  --card:#F6F6EE;
  --ink:#23271C;
  --muted:#5E6353;
  --tomato:#CB2B1E;
  --tomato-d:#A81F14;
  --olive:#6E7C33;
  --saffron:#DD9B2E;
  --aubergine:#4B2E48;
  --line:rgba(35,39,28,.14);
  font-family:'Archivo',system-ui,sans-serif;
  color:var(--ink);
  background:var(--paper);
  min-height:100%;
  -webkit-font-smoothing:antialiased;
}
.lm-root *{box-sizing:border-box;}

.lm-header{
  display:flex;align-items:flex-end;justify-content:space-between;
  gap:16px;flex-wrap:wrap;
  padding:22px 22px 14px;border-bottom:2px solid var(--ink);
}
.lm-brand{display:flex;align-items:baseline;gap:8px;line-height:.8;}
.lm-brand-le{font-family:'Fraunces',serif;font-weight:400;font-style:italic;font-size:26px;color:var(--muted);}
.lm-brand-menu{font-family:'Fraunces',serif;font-weight:900;font-size:40px;letter-spacing:-.02em;color:var(--tomato);}
.lm-nav{display:flex;gap:4px;flex-wrap:wrap;}
.lm-nav button{
  font-family:'Archivo';font-size:15px;font-weight:600;color:var(--muted);
  background:none;border:none;padding:6px 10px;cursor:pointer;border-bottom:2px solid transparent;
}
.lm-nav button.on{color:var(--ink);border-bottom-color:var(--tomato);}
.lm-nav button:hover{color:var(--ink);}

.lm-main{max-width:860px;margin:0 auto;padding:22px;}

.lm-eyebrow{font-size:13px;font-weight:600;color:var(--tomato);margin:0 0 2px;font-style:italic;font-family:'Fraunces',serif;}
.lm-title{font-family:'Fraunces',serif;font-weight:900;font-size:34px;line-height:1.02;margin:0;letter-spacing:-.02em;}

.lm-weekbar{
  display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;
  margin-bottom:16px;
}
.lm-cta{
  font-family:'Archivo';font-weight:700;font-size:16px;color:var(--paper);
  background:var(--tomato);border:none;border-radius:2px;padding:14px 22px;cursor:pointer;
  transition:background .15s ease;
}
.lm-cta:hover:not(:disabled){background:var(--tomato-d);}
.lm-cta:disabled{opacity:.6;cursor:progress;}

.lm-guests{margin-bottom:18px;}
.lm-guests-toggle{
  font-family:'Archivo';font-weight:600;font-size:14px;color:var(--ink);
  background:none;border:1px dashed var(--line);border-radius:2px;padding:9px 12px;cursor:pointer;
}
.lm-guests-toggle:hover{border-color:var(--olive);}
.lm-guests-body{margin-top:12px;padding:14px;background:var(--card);border-radius:2px;}
.lm-guest-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 0;}
.lm-check{display:flex;align-items:center;gap:7px;font-weight:600;cursor:pointer;min-width:118px;}
.lm-check input{width:17px;height:17px;accent-color:var(--tomato);}
.lm-num{width:64px;padding:7px 8px;border:1px solid var(--line);border-radius:2px;font-family:'Archivo';background:#fff;}
.lm-prefs{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--line);border-radius:2px;font-family:'Archivo';background:#fff;}

.lm-guest-row{flex-direction:column;align-items:stretch;gap:8px;border-bottom:1px solid var(--line);}
.lm-guest-row:last-child{border-bottom:none;}
.lm-guest-head{display:flex;align-items:center;gap:14px;}
.lm-couverts{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);}
.lm-guest-detail{display:flex;flex-direction:column;gap:8px;padding:0 0 4px 2px;}
.lm-chips{display:flex;gap:7px;flex-wrap:wrap;}
.lm-chip{
  font-family:'Archivo';font-weight:600;font-size:13px;color:var(--muted);
  background:#fff;border:1px solid var(--line);border-radius:99px;padding:5px 13px;cursor:pointer;
}
.lm-chip:hover{border-color:var(--olive);color:var(--ink);}
.lm-chip.on{background:var(--olive);border-color:var(--olive);color:#fff;}
.lm-guest-edit{display:flex;align-items:center;gap:8px;margin:8px 0;flex-wrap:wrap;}
.lm-num-nom{width:110px;padding:8px 10px;border:1px solid var(--line);border-radius:2px;font-family:'Archivo';font-size:14px;background:#fff;}

.lm-hint{font-size:13px;color:var(--muted);margin:6px 0 10px;line-height:1.5;}

.lm-error{background:#fbe6e4;color:var(--tomato-d);padding:12px 14px;border-radius:2px;margin-bottom:16px;font-weight:600;font-size:14px;}

.lm-progress{margin:8px 0 20px;}
.lm-progress-bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden;}
.lm-progress-fill{height:100%;background:var(--olive);transition:width .4s ease;}
.lm-progress p{font-size:13px;color:var(--muted);margin:8px 0 0;}

.lm-empty{padding:40px 0;max-width:520px;}
.lm-empty-big{font-family:'Fraunces',serif;font-weight:900;font-size:30px;line-height:1.05;margin:0 0 12px;letter-spacing:-.02em;}
.lm-empty-sub{font-size:16px;line-height:1.6;color:var(--muted);margin:0;}

.lm-day{margin:0 0 30px;}
.lm-dayname{
  font-family:'Fraunces',serif;font-weight:900;font-size:22px;margin:0 0 12px;
  padding-bottom:6px;border-bottom:1px solid var(--line);letter-spacing:-.01em;
}
.lm-meals{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:640px){.lm-meals{grid-template-columns:1fr;}}

.lm-card{
  background:var(--card);border-radius:2px;padding:16px 16px 18px;
  border-left:4px solid var(--olive);
}
.lm-card-diner{border-left-color:var(--aubergine);}
.lm-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.lm-two-courses{color:var(--tomato);font-weight:700;}
.lm-course{display:flex;flex-direction:column;}
.lm-course-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;min-height:20px;}
.lm-course-label{font-family:'Fraunces',serif;font-weight:900;font-size:12.5px;color:var(--aubergine);text-transform:uppercase;letter-spacing:.04em;}
.lm-course-sep{height:1px;background:var(--line);margin:14px 0;}
.lm-course-label-wrap{display:inline-flex;align-items:center;min-height:20px;}
.lm-course-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
.lm-swap{
  font-family:'Archivo';font-weight:700;font-size:12px;color:var(--tomato-d);
  background:rgba(203,43,30,.08);border:1px solid rgba(203,43,30,.25);border-radius:99px;
  padding:4px 10px;cursor:pointer;white-space:nowrap;
}
.lm-swap:hover{background:rgba(203,43,30,.16);}
.lm-add-entree{
  font-family:'Archivo';font-weight:700;font-size:13px;color:var(--aubergine);
  background:none;border:1px dashed var(--line);border-radius:2px;
  padding:8px 12px;cursor:pointer;margin-bottom:12px;width:100%;
}
.lm-add-entree:hover{border-color:var(--aubergine);}
.lm-rate{display:flex;align-items:center;gap:7px;margin-top:12px;flex-wrap:wrap;}
.lm-rate-q{font-size:12.5px;color:var(--muted);font-weight:600;}
.lm-rate-btn{
  font-family:'Archivo';font-weight:700;font-size:12.5px;color:var(--muted);
  background:#fff;border:1px solid var(--line);border-radius:99px;padding:5px 12px;cursor:pointer;
}
.lm-rate-btn:hover{border-color:var(--ink);color:var(--ink);}
.lm-rate-bof.on{background:#e9e4d6;border-color:#c9beA6;color:#6b5d3e;}
.lm-rate-moyen.on{background:rgba(221,155,46,.22);border-color:var(--saffron);color:#8a5e12;}
.lm-rate-top.on{background:var(--olive);border-color:var(--olive);color:#fff;}
.lm-meal-label{font-size:12.5px;font-weight:700;color:var(--muted);text-transform:none;}
.lm-badges{display:flex;gap:6px;}
.lm-badge{font-size:11.5px;font-weight:600;background:rgba(35,39,28,.07);padding:3px 8px;border-radius:99px;color:var(--ink);}
.lm-badge-temps{background:rgba(221,155,46,.22);}

.lm-plat{font-family:'Fraunces',serif;font-weight:600;font-size:20px;line-height:1.12;margin:2px 0 6px;}
.lm-twist{font-family:'Fraunces',serif;font-style:italic;font-size:14.5px;color:var(--muted);margin:0 0 10px;line-height:1.4;}
.lm-loading{font-size:13px;color:var(--muted);font-style:italic;}

.lm-card-error{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--tomato-d);flex-wrap:wrap;}

.lm-open{
  font-family:'Archivo';font-weight:600;font-size:13.5px;color:var(--ink);
  background:none;border:1px solid var(--line);border-radius:2px;padding:8px 12px;cursor:pointer;margin-top:4px;
}
.lm-open:hover{border-color:var(--ink);}
.lm-mini{
  font-family:'Archivo';font-weight:600;font-size:13px;color:var(--tomato-d);
  background:none;border:none;cursor:pointer;padding:6px 0;text-decoration:underline;
}

.lm-recette{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);}
.lm-recette h4{font-family:'Fraunces',serif;font-weight:600;font-size:15px;margin:14px 0 6px;}
.lm-recette h4:first-child{margin-top:0;}
.lm-ing{list-style:none;padding:0;margin:0;}
.lm-ing li{font-size:14px;line-height:1.55;padding:2px 0;border-bottom:1px dotted var(--line);}
.lm-ing-nom{font-weight:600;}
.lm-ing-q{color:var(--muted);}
.lm-steps{margin:0;padding-left:20px;}
.lm-steps li{font-size:14px;line-height:1.6;margin-bottom:8px;}

.lm-courses .lm-rayon{margin:20px 0;}
.lm-rayon-titre{font-family:'Fraunces',serif;font-weight:900;font-size:18px;margin:0 0 8px;color:var(--olive);}
.lm-courses ul{list-style:none;padding:0;margin:0;}
.lm-courses li{
  display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  padding:9px 0;border-bottom:1px solid var(--line);
}
.lm-courses li.done .lm-course-nom{text-decoration:line-through;color:var(--muted);}
.lm-course-nom{font-size:15px;font-weight:600;}
.lm-course-q{font-size:13px;color:var(--muted);text-align:right;flex-shrink:0;}

.lm-reglages{max-width:560px;}
.lm-field{margin:16px 0;}
.lm-field label{display:block;font-weight:600;font-size:14px;margin-bottom:6px;}
.lm-field textarea,.lm-field input{
  width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:2px;
  font-family:'Archivo';font-size:15px;background:#fff;color:var(--ink);resize:vertical;
}
.lm-field-alert textarea{border-color:var(--tomato);}
.lm-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}

textarea:focus,input:focus,button:focus-visible{outline:2px solid var(--olive);outline-offset:2px;}

@media(prefers-reduced-motion:reduce){
  *{transition:none !important;animation:none !important;}
}
`}</style>
  );
}
