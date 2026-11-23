// Getting started guide: what a department does after downloading, in the order that works.
// One page (#/guide), linked from the setup card, the member card and Me. It never pops up on its own.
import { CONFIG, IS_NATIVE } from "./config.js";
import { S, isOfficer, isOwner } from "./state.js";
import { esc } from "./util.js";
import { icon } from "./ui.js";
import { getLang } from "./i18n.js";
import { bottomNav, demoStrip } from "./app.js";

const EN = {
  title: "Getting started",
  leadOfficer: "Most departments are running in one training night. This is the order that works.",
  leadMember: "Four things and you're ready for the next page-out.",
  officer: [
    ["Set up the department", "10 minutes, chief or officer", [
      ["Add your trucks", "Department, Trucks. They become one-tap choices on every call.", "#/dept"],
      ["Name your officers", "Department, Members, tap a name, Make officer. Officers start incidents, call PAR and see medical details on a call.", "#/dept"],
      ["Connect dispatch (optional)", "Department, Connections. Pages and dispatch emails can start the incident and alert the crew for you.", "#/connections", "owner"],
    ]],
    ["Get your crew on", "15 minutes, at the hall or by text", [
      ["Share the invite code", "Department shows your code. Text it to the crew, or print the station poster and put it up.", "#/dept"],
      ["Everyone gets the app", "iPhone: download Fire Ground Board from the App Store. Android or a computer: open fire.mkegroup.ca and add it to the home screen. Sign in with an email, then enter the code.", "appstore"],
      ["Turn on call alerts", "On every phone. That's how PAR checks and Missing alarms reach people.", null],
      ["Add members without the app", "Records, Roster, paste your list. Officers can still put them on the board during a call.", "#/records/roster"],
    ]],
    ["Practice at training", "One training night", [
      ["Start a practice incident", "Call it something like Training: PAR drill.", "start"],
      ["Everyone taps I'm responding", "Then change status as you go: Staged, In, Out, Rehab.", null],
      ["Call a PAR", "Watch who confirms and who gets flagged.", null],
      ["Try the Missing alarm", "Set one person to Missing so everyone hears it, then clear it.", null],
      ["Close it and look at the report", "Every incident keeps a timeline you can download.", null],
    ]],
    ["Go live", "Your next call", [
      ["Start the incident", "The first officer on the app starts it, or dispatch does if it's connected.", null],
      ["Crew taps I'm responding", "On the way to the hall or the scene. Command sees who's coming.", null],
      ["Command keeps the board open", "On a phone or tablet. Add trucks and mutual aid crews as they arrive.", null],
      ["Close it after", "Close the incident when you're back in service. The report is saved.", null],
    ]],
    ["Make it stick", "First month", [
      ["Use it on every call", "Even the small ones. That's what makes it habit before a big one.", null],
      ["Log training in the app", "Records, Training. Attendance and hours stay with each member.", "#/records/training"],
      ["Keep records current", "Roster, certifications and equipment, so officers have them on a call.", "#/records/roster"],
      ["Choose a plan before the trial ends", "Plan. Monthly or yearly. Billing starts when the trial ends.", "#/plan", "owner-web"],
    ]],
  ],
  member: [
    ["Get the app and join", null, [
      ["Download and sign in", "iPhone: Fire Ground Board on the App Store. Android or a computer: fire.mkegroup.ca, then add it to your home screen. Sign in with your email.", "appstore"],
      ["Enter your department's code", "Ask your chief or an officer. It's also on the station poster.", null],
    ]],
    ["Turn on call alerts", null, [
      ["Say yes to notifications", "That's how PAR checks and Missing alarms reach you, even with the app closed.", null],
    ]],
    ["On a call", null, [
      ["Paged? Tap I'm responding", "On the incident. You're on the board right away.", null],
      ["Keep your status current", "Tap your name: Staged, In, Out, Rehab. Command sees it live.", null],
      ["PAR called", "Your phone sounds. Tap I'm accounted for.", null],
      ["Missing alarm", "Every phone on the call gets it. Follow your officer's direction.", null],
    ]],
    ["Fill in your profile", null, [
      ["Certifications and emergency contact", "Me, then Certifications, medical, emergency contact. Officers can see these on a call.", "#/me"],
    ]],
  ],
  printable: "Print this",
  help: "Questions? Email hello@mkegroup.ca",
};

const FR = {
  title: "Pour commencer",
  leadOfficer: "La plupart des services sont prêts en une soirée de pratique. Voici l'ordre qui fonctionne.",
  leadMember: "Quatre choses et vous êtes prêt pour le prochain appel.",
  officer: [
    ["Configurer le service", "10 minutes, directeur ou officier", [
      ["Ajoutez vos camions", "Service, Camions. Ils deviennent des choix en un geste sur chaque appel.", "#/dept"],
      ["Nommez vos officiers", "Service, Membres, touchez un nom, Nommer officier. Les officiers lancent les interventions, demandent le PAR et voient les détails médicaux.", "#/dept"],
      ["Reliez la répartition (facultatif)", "Service, Connexions. Les pagettes et courriels de répartition peuvent lancer l'intervention et alerter l'équipe.", "#/connections", "owner"],
    ]],
    ["Faire embarquer l'équipe", "15 minutes, à la caserne ou par texto", [
      ["Partagez le code d'invitation", "Le code est dans Service. Textez-le à l'équipe ou imprimez l'affiche de la caserne.", "#/dept"],
      ["Tout le monde installe l'application", "iPhone : téléchargez Fire Ground Board dans l'App Store. Android ou ordinateur : ouvrez fire.mkegroup.ca et ajoutez-le à l'écran d'accueil. Connectez-vous avec un courriel, puis entrez le code.", "appstore"],
      ["Activez les alertes d'appel", "Sur chaque téléphone. C'est ainsi que les PAR et les alarmes « manquant » rejoignent les gens.", null],
      ["Ajoutez les membres sans l'application", "Registres, Effectif, collez votre liste. Les officiers peuvent quand même les mettre sur le tableau.", "#/records/roster"],
    ]],
    ["Pratiquer", "Une soirée de pratique", [
      ["Lancez une intervention de pratique", "Par exemple : Pratique PAR.", "start"],
      ["Tout le monde touche Je suis en route", "Puis change de statut au fil de l'appel : En attente, Dedans, Dehors, Réhab.", null],
      ["Demandez un PAR", "Voyez qui confirme et qui est signalé.", null],
      ["Essayez l'alarme « manquant »", "Mettez une personne à Manquant pour que tout le monde l'entende, puis annulez.", null],
      ["Fermez-la et regardez le rapport", "Chaque intervention garde une chronologie à télécharger.", null],
    ]],
    ["En service", "Votre prochain appel", [
      ["Lancez l'intervention", "Le premier officier sur l'application la lance, ou la répartition si elle est reliée.", null],
      ["L'équipe touche Je suis en route", "En route vers la caserne ou la scène. Le commandement voit qui arrive.", null],
      ["Le commandement garde le tableau ouvert", "Sur un téléphone ou une tablette. Ajoutez les camions et l'entraide à leur arrivée.", null],
      ["Fermez-la après", "Fermez l'intervention au retour en service. Le rapport est conservé.", null],
    ]],
    ["En faire une habitude", "Premier mois", [
      ["Utilisez-la à chaque appel", "Même les petits. C'est ce qui en fait un réflexe avant un gros appel.", null],
      ["Notez les formations", "Registres, Formation. Présences et heures restent avec chaque membre.", "#/records/training"],
      ["Gardez les registres à jour", "Membres, certifications et équipement, pour que les officiers les aient sur un appel.", "#/records/roster"],
      ["Choisissez un forfait avant la fin de l'essai", "Forfait. Mensuel ou annuel. La facturation commence à la fin de l'essai.", "#/plan", "owner-web"],
    ]],
  ],
  member: [
    ["Installer et se joindre", null, [
      ["Téléchargez et connectez-vous", "iPhone : Fire Ground Board dans l'App Store. Android ou ordinateur : fire.mkegroup.ca, puis ajoutez-le à l'écran d'accueil. Connectez-vous avec votre courriel.", "appstore"],
      ["Entrez le code de votre service", "Demandez-le à votre directeur ou à un officier. Il est aussi sur l'affiche de la caserne.", null],
    ]],
    ["Activer les alertes", null, [
      ["Acceptez les notifications", "C'est ainsi que les PAR et les alarmes « manquant » vous rejoignent, même application fermée.", null],
    ]],
    ["Sur un appel", null, [
      ["Pagette? Touchez Je suis en route", "Sur l'intervention. Vous êtes sur le tableau tout de suite.", null],
      ["Gardez votre statut à jour", "Touchez votre nom : En attente, Dedans, Dehors, Réhab. Le commandement le voit en direct.", null],
      ["PAR demandé", "Votre téléphone sonne. Touchez Je suis présent.", null],
      ["Alarme « manquant »", "Chaque téléphone de l'intervention la reçoit. Suivez les directives de votre officier.", null],
    ]],
    ["Remplir votre profil", null, [
      ["Certifications et personne à joindre", "Moi, puis Certifications, médical, personne à joindre. Les officiers les voient sur un appel.", "#/me"],
    ]],
  ],
  printable: "Imprimer",
  help: "Des questions? Écrivez à hello@mkegroup.ca",
};

export function guideView(root) {
  const L = getLang() === "fr" ? FR : EN;
  const officer = isOfficer();
  const sections = officer ? L.officer : L.member;
  const show = (who) => !who || (who === "owner" && isOwner()) || (who === "owner-web" && isOwner() && !IS_NATIVE);
  const link = (href, inner) => {
    if (!href) return `<div class="setup-step">${inner}</div>`;
    if (href === "appstore") return CONFIG.APP_STORE_URL && !IS_NATIVE
      ? `<a class="setup-step" href="${CONFIG.APP_STORE_URL}" target="_blank" rel="noopener">${inner}<span class="chev">${icon("chev", "sm")}</span></a>`
      : `<div class="setup-step">${inner}</div>`;
    if (href === "start") return `<a class="setup-step" href="#/">${inner}<span class="chev">${icon("chev", "sm")}</span></a>`;
    return `<a class="setup-step" href="${href}">${inner}<span class="chev">${icon("chev", "sm")}</span></a>`;
  };
  root.innerHTML = `
  ${demoStrip()}
  <div class="screen with-nav">
    <div class="wrap guide">
      <div class="section-head" style="margin-top:18px"><div class="h2">${esc(L.title)}</div><button class="btn sm quiet no-print" data-print>${icon("print", "sm")} ${esc(L.printable)}</button></div>
      <p class="muted" style="margin:4px 0 16px">${esc(officer ? L.leadOfficer : L.leadMember)}</p>
      ${sections.map(([head, when, steps], i) => {
        const shown = steps.filter((s) => show(s[3]));
        if (!shown.length) return "";
        return `<div class="panel setup" style="margin-bottom:12px">
          <div style="display:flex;align-items:baseline;gap:10px"><span class="tick num" style="width:26px;height:26px;border-radius:50%;border:2px solid var(--muted);display:grid;place-items:center;font:800 14px/1 var(--head);flex:none">${i + 1}</span><div class="h3" style="flex:1">${esc(head)}</div>${when ? `<span class="muted small">${esc(when)}</span>` : ""}</div>
          <div class="setup-steps">${shown.map(([t, m, href]) => link(href, `<span class="grow"><b>${esc(t)}</b><small>${esc(m)}</small></span>`)).join("")}</div>
        </div>`;
      }).join("")}
      <p class="muted small" style="text-align:center;margin:18px 0 40px">${esc(L.help)}</p>
    </div>
  </div>
  ${bottomNav(officer ? "dept" : "me")}`;
  const onClick = (e) => { if (e.target.closest("[data-print]")) window.print(); };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
