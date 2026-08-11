import type { EditableRule, RadarApi, StatusSection, UiGroup, UiItem, UiSnapshot, UiStatusGroup } from './contract';
import { FIELD_LABELS, changeTerm } from './contract.js';
import { sortedGroups, type SortMode } from './sort.js';
import {
  createSelect,
  applyTheme,
  checkboxField,
  createBadge,
  createButton,
  createChip,
  createCollapsible,
  createRemovableChip,
  createRow,
  createStatusMessage,
  createTabBar,
  el,
  eyeIcon,
  numberField,
  registerDropdown,
  selectField,
  textField,
} from './ui.js';

/**
 * Popover renderer.
 *
 * Plain DOM, no framework and no bundler — the whole view is a few hundred rows
 * at most, and keeping it dependency-free means `yarn build` is just `tsc`.
 *
 * Everything is built with createElement/textContent rather than innerHTML, so
 * MR titles and comment authors from GitLab can never be interpreted as markup.
 */

declare global {
  interface Window {
    radar: RadarApi;
  }
}

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const listEl = byId('list');
const statusEl = byId('status');
const sourcesEl = byId('sources');
const pollBtn = byId<HTMLButtonElement>('poll');
const pauseBtn = byId<HTMLButtonElement>('pause');
const markReadBtn = byId<HTMLButtonElement>('mark-read');

const settingsBtn = byId<HTMLButtonElement>('settings-btn');
const settingsEl = byId('settings');
const sortSelect = byId<HTMLSelectElement>('sort');
const filterBtn = byId<HTMLButtonElement>('filter-btn');
const filterMenu = byId('filter-menu');


pollBtn.addEventListener('click', () => void window.radar.pollNow());
pauseBtn.addEventListener('click', () => void window.radar.togglePause());
markReadBtn.addEventListener('click', () => void window.radar.markAllRead());
settingsBtn.addEventListener('click', () => void toggleSettings());
window.radar.onShowSettings(() => void openSettings());

// -- sort & filter preferences (client-side, persisted in localStorage) -------
/**
 * What this install's forge calls a change proposal — 'MR' on GitLab, 'PR' on
 * GitHub. Every label that names one reads through `mr()`/`mrs()`, so a GitHub
 * user never sees "MR"; the app's own name stays MR Radar. Snapshot-driven, so
 * it is right from the first paint and follows a forge switch in Settings.
 */
let forgeTerm: 'MR' | 'PR' = 'MR';
const mr = (): string => forgeTerm;
const mrs = (): string => `${forgeTerm}s`;

/**
 * 'work' = MRs I authored; 'reviews' = definitive reviewer signal (requested
 * or approved); 'participating' = looser — commented on or mentioned.
 */
type Tab = 'work' | 'reviews' | 'participating';

const inTab = (item: UiItem, tab: Tab): boolean => {
  if (tab === 'work') return item.reason === 'authored';
  if (tab === 'reviews') return item.reason === 'reviewer';
  return item.reason === 'participating';
};

/**
 * A ticket with no MR belongs to "My work": it's yours to push, and there is
 * nothing on it to review or participate in.
 */
const NO_MR_TAB: Tab = 'work';

interface Filters {
  unread: boolean;
  threads: boolean;
  review: boolean;
  approval: boolean;
  ciFailed: boolean;
  testsNotRun: boolean;
  conflict: boolean;
  overdue: boolean;
  noMr: boolean;
}

/** Filters that ask something of an individual MR. */
const ITEM_FILTERS: { key: keyof Filters; label: string; test: (i: UiItem) => boolean }[] = [
  { key: 'unread', label: 'Unread', test: (i) => i.unread },
  { key: 'threads', label: 'Open threads', test: (i) => i.unresolved > 0 },
  { key: 'review', label: 'Needs my review', test: (i) => i.reason === 'reviewer' },
  { key: 'approval', label: 'Needs approval', test: (i) => (i.approvals?.left ?? 0) > 0 },
  { key: 'ciFailed', label: 'CI failed', test: (i) => i.ci.tone === 'bad' && !i.ci.startable },
  { key: 'testsNotRun', label: 'Tests not run', test: (i) => i.ci.startable },
  { key: 'conflict', label: 'Merge conflict', test: (i) => i.hasConflicts },
  { key: 'overdue', label: 'Overdue', test: (i) => i.overdue },
];

/**
 * Filters about the group rather than an MR in it. "No MR yet" selects a
 * different population entirely — tickets, not merge requests — so it's
 * mutually exclusive with the item filters (see buildFilterMenu): combining
 * them could only ever yield an empty list.
 */
const groupFilters = (): { key: keyof Filters; label: string; title: string }[] => [
  {
    key: 'noMr',
    label: `No ${mr()} yet`,
    title: `Only active tickets that have no ${mr() === 'PR' ? 'pull' : 'merge'} request`,
  },
];

/** Built per call: the group filter's label carries the forge's own word. */
const allFilters = (): { key: keyof Filters; label: string; title?: string }[] => [
  ...ITEM_FILTERS,
  ...groupFilters(),
];

const PREFS_KEY = 'mr-radar-prefs';
const emptyFilters = (): Filters => ({
  unread: false,
  threads: false,
  review: false,
  approval: false,
  ciFailed: false,
  testsNotRun: false,
  conflict: false,
  overdue: false,
  noMr: false,
});

const loadPrefs = (): { sort: SortMode; filters: Filters; tab: Tab } => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { sort?: SortMode; filters?: Partial<Filters>; tab?: Tab };
      return {
        sort: p.sort ?? 'attention',
        filters: { ...emptyFilters(), ...p.filters },
        tab: p.tab === 'reviews' || p.tab === 'participating' ? p.tab : 'work',
      };
    }
  } catch {
    /* ignore malformed prefs */
  }
  return { sort: 'attention', filters: emptyFilters(), tab: 'work' };
};

const prefs = loadPrefs();
let lastSnapshot: UiSnapshot | undefined;


const savePrefs = (): void => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full/unavailable — prefs just won't persist */
  }
};

sortSelect.value = prefs.sort;
sortSelect.addEventListener('change', () => {
  prefs.sort = sortSelect.value as SortMode;
  savePrefs();
  if (lastSnapshot) renderList(lastSnapshot);
});

const selectTab = (tab: Tab): void => {
  prefs.tab = tab;
  savePrefs();
  if (lastSnapshot) {
    paintTabs(lastSnapshot);
    renderList(lastSnapshot);
  }
};
const mainTabs = createTabBar<Tab>({
  tabs: [
    { key: 'work', label: 'My work' },
    { key: 'reviews', label: 'My reviews' },
    { key: 'participating', label: 'Participating' },
  ],
  active: prefs.tab,
  onSelect: selectTab,
  ariaLabel: `${mr()} buckets`,
});
byId('tabs').replaceWith(mainTabs.root);

/** Tab labels carry live counts; the active tab is marked for the CSS. */
const paintTabs = (s: UiSnapshot): void => {
  // 'active' counts what needs doing (active + needs-value sections), so the
  // labels agree with the header's "N in scope"; 'all' counts every section
  // shown (Verification/Done/Other too — never Ignored).
  const groups =
    (s.tabCounts ?? 'all') === 'active'
      ? [...s.groups, ...(s.needsGroups ?? [])]
      : [...s.groups, ...(s.needsGroups ?? []), ...(s.verificationGroups ?? []), ...(s.doneGroups ?? []), ...s.otherGroups];
  const items = groups.flatMap((g) => g.items);
  // No-MR rows carry no items, so they'd count as nothing — the one thing this
  // feature exists to prevent. Counted under their tab in both modes: a ticket
  // with no MR is active work by definition.
  const noMrCount = (s.noMrGroups ?? []).length;
  const count = (tab: Tab): number =>
    items.filter((i) => inTab(i, tab)).length + (tab === NO_MR_TAB ? noMrCount : 0);
  mainTabs.setLabel('work', `My work (${count('work')})`);
  mainTabs.setLabel('reviews', `My reviews (${count('reviews')})`);
  mainTabs.setLabel('participating', `Participating (${count('participating')})`);
  mainTabs.setActive(prefs.tab);
};

registerDropdown(filterBtn, filterMenu);

const activeFilterCount = (): number => allFilters().filter((f) => prefs.filters[f.key]).length;

const buildFilterMenu = (): void => {
  filterMenu.replaceChildren();
  for (const def of allFilters()) {
    const row = el('label', 'filter-row');
    if (def.title) row.title = def.title;
    const cb = el('input', 'filter-cb');
    cb.type = 'checkbox';
    cb.checked = prefs.filters[def.key];
    cb.addEventListener('change', () => {
      prefs.filters[def.key] = cb.checked;
      // Ticket-population and MR-population filters can't hold at once, so
      // turning one on releases the other rather than emptying the list.
      if (cb.checked) {
        if (def.key === 'noMr') for (const f of ITEM_FILTERS) prefs.filters[f.key] = false;
        else prefs.filters.noMr = false;
      }
      savePrefs();
      buildFilterMenu();
      updateFilterBtn();
      if (lastSnapshot) renderList(lastSnapshot);
    });
    row.append(cb, el('span', undefined, def.label));
    filterMenu.append(row);
  }
  const clear = el('button', 'filter-clear', 'Clear filters');
  clear.addEventListener('click', () => {
    for (const def of allFilters()) prefs.filters[def.key] = false;
    savePrefs();
    buildFilterMenu();
    updateFilterBtn();
    if (lastSnapshot) renderList(lastSnapshot);
  });
  filterMenu.append(clear);
};

const updateFilterBtn = (): void => {
  const n = activeFilterCount();
  filterBtn.textContent = n > 0 ? `Filter (${n})` : 'Filter';
  filterBtn.classList.toggle('active', n > 0);
};

buildFilterMenu();
updateFilterBtn();

// Theme before first paint-ish: settings carry it in both shells.
void window.radar.getSettings().then((s) => applyTheme(s.theme, s.appearance));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!settingsEl.hidden) closeSettings();
    else void window.radar.close();
  }
  if (e.key === 'r' && (e.metaKey || e.ctrlKey)) void window.radar.pollNow();
});

let lastListKey: string | undefined;

const render = (snapshot: UiSnapshot): void => {
  lastSnapshot = snapshot;
  const term = changeTerm(snapshot.forge);
  if (term !== forgeTerm) {
    // Rebuild everything that bakes the word in at construction time.
    forgeTerm = term;
    buildFilterMenu();
    updateFilterBtn();
    mainTabs.root.setAttribute('aria-label', `${term} buckets`);
    lastListKey = undefined; // force the list to re-render with the new wording
  }
  renderStatus(snapshot);
  renderSources(snapshot);
  renderConnect(snapshot);
  paintTabs(snapshot);
  // Rebuild the list only when its CONTENT changed. Status-only pushes (e.g.
  // "polling…" at cycle start) re-send the same snapshot — rebuilding then
  // wipes in-place button state ("Starting…"/"Current run") milliseconds
  // after a click, which reads as the click having done nothing.
  const listKey = `${snapshot.at}|${[...snapshot.unreadKeys].sort().join(',')}`;
  if (listKey !== lastListKey) {
    lastListKey = listKey;
    renderList(snapshot);
  }
  flashHighlight(snapshot);
  markReadBtn.disabled = snapshot.unreadCount === 0;
  markReadBtn.textContent =
    snapshot.unreadCount > 0 ? `Mark all read (${snapshot.unreadCount})` : 'Mark all read';
}

// -- sort & filter application ------------------------------------------------

/** Groups passing the active filters, with their items filtered too. */
const filteredGroups = (groups: UiGroup[]): UiGroup[] => {
  const active = ITEM_FILTERS.filter((f) => prefs.filters[f.key]);
  const onlyNoMr = prefs.filters.noMr;
  if (active.length === 0 && !onlyNoMr) return groups;
  const out: UiGroup[] = [];
  for (const g of groups) {
    // A ticket with no MR can't satisfy an MR-level test, so any of those
    // filters excludes it — and the No-MR filter keeps nothing else.
    if (g.noMr) {
      if (active.length === 0) out.push(g);
      continue;
    }
    if (onlyNoMr) continue;
    const items = g.items.filter((i) => active.every((f) => f.test(i)));
    if (items.length) out.push({ ...g, items });
  }
  return out;
};

const connectEl = byId('connect');

/**
 * The in-app Jira token field. Shown only until a token is stored, so it's a
 * one-time affordance rather than a permanent settings panel — the token itself
 * goes to the Keychain, never into the DOM beyond this transient input.
 */
const renderConnect = (s: UiSnapshot): void => {
  if (!s.jiraNeedsToken) {
    connectEl.replaceChildren();
    connectEl.hidden = true;
    delete connectEl.dataset.rendered;
    return;
  }
  if (connectEl.dataset.rendered === '1') return; // don't clobber a value mid-typing
  connectEl.hidden = false;
  connectEl.dataset.rendered = '1';

  const label = el('div', 'connect-label', 'Connect Jira to scope by active ticket');
  const sub = el(
    'div',
    'connect-sub',
    s.jiraEmail ? `Token for ${s.jiraEmail}` : 'Set the Atlassian URL and email in Settings → Jira first',
  );

  const row = el('div', 'connect-row');
  const input = el('input', 'connect-input');
  input.type = 'password';
  input.placeholder = 'Paste Jira API token';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.disabled = !s.jiraEmail;

  const save = el('button', undefined, 'Connect');
  save.disabled = !s.jiraEmail;

  const msg = createStatusMessage('connect-msg');

  const submit = (): void => {
    const token = input.value.trim();
    if (!token) return;
    save.disabled = true;
    input.disabled = true;
    msg.set('Verifying…');
    void window.radar.setJiraToken(token).then((res) => {
      msg.set(res.message, res.ok ? 'ok' : 'err');
      input.value = '';
      if (!res.ok) {
        save.disabled = false;
        input.disabled = false;
      }
      // On success the next snapshot arrives with jiraNeedsToken=false, which
      // clears this whole block.
    });
  };

  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  row.append(input, save);
  connectEl.replaceChildren(label, sub, row, msg.root);
}

const renderStatus = (s: UiSnapshot): void => {
  pauseBtn.textContent = s.enabled ? 'Pause' : 'Resume';
  pollBtn.disabled = s.polling;

  statusEl.className = 'status';
  if (s.paused) {
    statusEl.className = 'status paused';
    statusEl.textContent = s.paused;
    return;
  }
  if (s.polling) {
    statusEl.textContent = 'Polling…';
    return;
  }
  if (s.lastError) {
    statusEl.className = 'status error';
    statusEl.textContent = `Last poll failed — ${s.lastError}`;
    return;
  }

  const parts: string[] = [];
  if (s.lastPollAt) parts.push(`checked ${timeAgo(s.lastPollAt)}`);
  if (s.nextPollAt) parts.push(`next ${clock(s.nextPollAt)}`);
  // Two different populations, two different words: "active" is the work
  // slice at the top of the list; "tracked" is everything the radar polls —
  // the exact number the tray menu shows. Both together kill the 8-vs-28
  // mystery.
  const active =
    [...s.groups, ...(s.needsGroups ?? [])].reduce((n, g) => n + g.items.length, 0) +
    // A ticket with no MR is one active thing, with zero items to add up.
    (s.noMrGroups ?? []).length;
  const tracked = s.trackedCount ?? active;
  parts.push(active === tracked ? `${active} active` : `${active} active · ${tracked} tracked`);
  statusEl.textContent = parts.join(' · ');
}

const renderSources = (s: UiSnapshot): void => {
  sourcesEl.replaceChildren();
  for (const src of s.sources) {
    const cls = src.ok ? (src.stale ? 'source stale' : 'source') : 'source down';
    const node = el('span', cls, src.name);
    if (src.error) node.title = src.error;
    else if (src.stale) node.title = 'using cached data';
    sourcesEl.append(node);
  }
}

let lastHighlightAt: string | undefined;

/** Scroll to and pulse the row a clicked notification pointed at. */
const flashHighlight = (s: UiSnapshot): void => {
  const h = s.highlight;
  if (!h || h.at === lastHighlightAt) return;
  lastHighlightAt = h.at;
  const row = listEl.querySelector<HTMLElement>(`[data-mr-key="${CSS.escape(h.key)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('row-flash');
  setTimeout(() => row.classList.remove('row-flash'), 2600);
};

const renderList = (s: UiSnapshot): void => {
  listEl.replaceChildren();

  if (s.groups.length === 0 && s.otherGroups.length === 0) {
    const why = s.sources.some((src) => src.name === 'jira' && !src.ok)
      ? 'Nothing in scope. Jira is unavailable, so no active tickets are known — run `yarn jira:token` to connect it.'
      : `Nothing in scope. No ${mrs()} match an active Jira ticket.`;
    listEl.append(el('p', 'empty', why));
    return;
  }

  // The tab is the outermost cut: My work = authored, My reviews = the rest.
  const tabbed = s.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => inTab(i, prefs.tab)) }))
    .filter((g) => g.items.length > 0);
  // No-MR groups carry no items to test, so their whole section belongs to one
  // tab: they're yours to push, with nothing on them to review.
  const tabbedNoMr = prefs.tab === NO_MR_TAB ? (s.noMrGroups ?? []) : [];
  const tabbedNeeds = (s.needsGroups ?? [])
    .map((g) => ({ ...g, items: g.items.filter((i) => inTab(i, prefs.tab)) }))
    .filter((g) => g.items.length > 0);
  const tabStatusGroups = (gs: UiStatusGroup[]): UiStatusGroup[] =>
    gs
      .map((g) => ({ ...g, items: g.items.filter((i) => inTab(i, prefs.tab)) }))
      .filter((g) => g.items.length > 0);

  const groups = sortedGroups(filteredGroups(tabbed), prefs.sort);
  const needs = sortedGroups(filteredGroups(tabbedNeeds), prefs.sort);
  const noMr = sortedGroups(filteredGroups(tabbedNoMr), prefs.sort);
  const verification = otherView(tabStatusGroups(s.verificationGroups ?? []));
  const done = otherView(tabStatusGroups(s.doneGroups ?? []));
  const other = otherView(tabStatusGroups(s.otherGroups));

  if (
    groups.length === 0 && needs.length === 0 && noMr.length === 0 &&
    verification.length === 0 && done.length === 0 && other.length === 0
  ) {
    const emptyByTab: Record<Tab, string> = {
      work: `No authored ${mrs()} in scope.`,
      reviews: 'No reviews on your radar — nothing you approved or were asked to review.',
      participating:
        `Nothing you commented on or were mentioned in (outside your own ${mrs()} and reviews).`,
    };
    const anyInTab =
      tabbed.length + tabbedNeeds.length + tabbedNoMr.length + verification.length + done.length + other.length > 0;
    const msg = anyInTab ? `No ${mrs()} match the current filters.` : emptyByTab[prefs.tab];
    listEl.append(el('p', 'empty', msg));
    return;
  }
  for (const group of groups) listEl.append(renderGroup(group));
  if (needs.length > 0) {
    // Tickets a rule flagged as missing a value: one unmissable section per
    // missing field ("Needs fix version", "Needs due date", ...).
    const byLabel = new Map<string, UiGroup[]>();
    for (const g of needs) {
      const label = g.ticket?.needsField ? FIELD_LABELS[g.ticket.needsField] : 'attention';
      const bucket = byLabel.get(label) ?? [];
      bucket.push(g);
      byLabel.set(label, bucket);
    }
    for (const [label, gs] of byLabel) {
      listEl.append(el('div', 'other-status section-heading', `Needs ${label} (${gs.length})`));
      for (const group of gs) listEl.append(renderGroup(group));
    }
  }
  // Above Verification: not yet started is nearer to your hands than
  // out-of-your-hands, but it is still not a merge request.
  if (noMr.length > 0) listEl.append(renderNoMrSection(noMr, prefs.filters.noMr));
  if (verification.length > 0) {
    listEl.append(renderStatusSection('Verification', verification, 'mr-radar-verification-collapsed', true));
  }
  if (other.length > 0) listEl.append(renderStatusSection('Other', other, 'mr-radar-other-collapsed', true));
  if (done.length > 0) listEl.append(renderStatusSection('Done', done, 'mr-radar-done-collapsed', true));
  // Ignored (by rule or by hand) sits below even Done: silent, but one click
  // from coming back. Deliberately outside the tab/filter/empty-state math —
  // ignored MRs count toward nothing.
  const ignored = s.ignoredGroups ?? [];
  if (ignored.length > 0) {
    listEl.append(renderStatusSection('Ignored', ignored, 'mr-radar-ignored-collapsed', true));
  }
}

/** Filter + sort the non-active "Other" status groups the same way as active. */
const otherView = (statusGroups: UiStatusGroup[]): UiStatusGroup[] => {
  // These sections are MRs by construction — the No-MR filter empties them.
  if (prefs.filters.noMr) return [];
  const active = ITEM_FILTERS.filter((f) => prefs.filters[f.key]);
  const filtered = statusGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => active.every((f) => f.test(i))) }))
    .filter((g) => g.items.length > 0);
  // Within the collapsed section, always order by status workflow rank.
  return filtered
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => a.attention.rank - b.attention.rank) }))
    .sort((a, b) => a.statusRank - b.statusRank);
};

/**
 * A collapsible block of status groups — used for Verification, Other, and
 * Done. All default collapsed (they're "not my move" buckets); the collapse
 * state persists per section once toggled.
 */
const renderStatusSection = (
  label: string,
  statusGroups: UiStatusGroup[],
  storageKey: string,
  defaultCollapsed: boolean,
): HTMLElement => {
  const total = statusGroups.reduce((n, g) => n + g.items.length, 0);
  const section = createCollapsible({ label: () => `${label} (${total})`, storageKey, defaultCollapsed });
  for (const g of statusGroups) {
    section.body.append(el('div', 'other-status', `${g.status} · ${g.items.length}`));
    for (const item of g.items) section.body.append(renderRow(item));
  }
  return section.root;
};

/**
 * Tickets with no merge request, collapsed under one header. Ticket-headed
 * groups rather than status ones, so each row keeps its key, status and summary
 * — but out of the way of the MRs, which is where they were drowning.
 */
const renderNoMrSection = (groups: UiGroup[], forceOpen: boolean): HTMLElement => {
  const section = createCollapsible({
    label: () => `No ${mr()} yet (${groups.length})`,
    // With the No-MR filter on, these rows ARE the request: open the section,
    // and don't let a remembered "collapsed" hide the only thing on screen.
    ...(forceOpen ? {} : { storageKey: 'mr-radar-no-mr-collapsed' }),
    defaultCollapsed: !forceOpen,
  });
  for (const group of groups) section.body.append(renderGroup(group));
  return section.root;
};

const renderGroup = (group: UiGroup): HTMLElement => {
  const wrap = el('section', 'group');

  if (group.ticket) {
    const head = el('div', 'group-head');
    // Only the key is the link — a full-width click target made every stray
    // click in the header row open Jira.
    const key = el('span', 'ticket-key', group.ticket.key);
    key.title = 'Open in Jira';
    const url = group.ticket.url;
    key.addEventListener('click', () => void window.radar.openUrl(url));
    head.append(key);
    head.append(el('span', 'ticket-status', group.ticket.status));
    // Nothing to ignore when there's no MR — the eye would be a dead control.
    if (!group.noMr) head.append(eyeControl(group.items, true)); // styles push it hard right
    wrap.append(head);
  } else {
    const head = el('div', 'group-head');
    head.append(el('span', undefined, 'No active ticket'), eyeControl(group.items, true));
    wrap.append(head);
  }

  if (group.noMr) {
    wrap.append(noMrRow(group.noMr, group.ticket?.url ?? ''));
    return wrap;
  }
  // The fix-version picker is a *ticket*-level action, so it rides the first
  // row rather than repeating on each of the ticket's MRs — in the side column
  // under the CI chip, with the other actions, instead of wedged into the
  // header between the status and the eye.
  const needsFixVersion = group.ticket?.needsField === 'fixVersions' ? group.ticket.key : undefined;
  group.items.forEach((item, i) => {
    wrap.append(
      renderRow(item, {
        eye: false,
        ...(i === 0 && needsFixVersion ? { sideExtra: fixVersionControl(needsFixVersion) } : {}),
      }),
    );
  });
  return wrap;
}

/**
 * The stand-in row for a ticket with no merge request. The Jira summary takes
 * the title's place — it's the only content such a row has — and the attention
 * line says whether that's expected. Clicking opens the ticket, since there is
 * no MR to open.
 */
const noMrRow = (noMr: NonNullable<UiGroup['noMr']>, ticketUrl: string): HTMLElement => {
  const row = createRow({
    unread: false,
    onClick: () => {
      if (ticketUrl) void window.radar.openUrl(ticketUrl);
    },
  });
  row.root.classList.add('row-no-mr');
  row.main.append(el('div', 'row-title', noMr.summary));
  row.main.append(el('div', `attention attention-${noMr.attention.tone}`, noMr.attention.text));
  row.meta.append(
    createBadge(
      `no ${mr()}`,
      noMr.expected ? 'warn' : 'muted',
      noMr.expected
        ? `No ${mr()} is open for this ticket, and one is expected at this status`
        : `No ${mr()} is open for this ticket yet`,
    ),
  );
  row.main.append(row.meta);
  return row.root;
};

/** `.rwx/frontend-ci.yml` → `frontend` (mirrors present.ts). */
const shortCheckName = (name: string): string =>
  name.replace(/^\.rwx\//, '').replace(/(-ci)?\.ya?ml$/, '');

/** Mirrors present.ts: merging into anything else deserves a callout. */
const isMainline = (target: string): boolean =>
  target === '' || target === 'main' || target === 'master';

/**
 * Promote a drive-by into the formal reviewer role. Confirmed in the page
 * (it edits a shared MR), keeps the existing reviewers, and the row migrates
 * to "My reviews" on the next cycle.
 */
const becomeReviewerButton = (item: UiItem): HTMLElement => {
  const btn = createButton('Become reviewer', {
    variant: 'action',
    title: `Add yourself as a reviewer on ${item.key}`,
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!window.confirm(`Add yourself as a reviewer on ${item.key}?\n\n${item.title}`)) return;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    void window.radar.becomeReviewer(item.key).then((r) => {
      btn.textContent = r.ok ? 'Reviewer ✓' : 'Failed';
      btn.title = r.message;
      if (!r.ok) btn.disabled = false;
    });
  });
  return btn;
};

/**
 * "Set fix version" on a row that needs one: click loads the project's
 * unreleased versions into an inline select; picking one + Assign writes it to
 * Jira (the app's only Jira write).
 *
 * On success the picker collapses to a green confirmation rather than sitting
 * there as a spent select next to a disabled button — and the main process has
 * already re-read the ticket, so the pushed snapshot removes this control (and
 * the "needs a fix version" line) within the same beat. The confirmation only
 * has to survive until that arrives.
 */
const fixVersionControl = (ticketKey: string): HTMLElement => {
  const wrap = el('span', 'fixversion');
  const btn = createButton('Set fix version', {
    variant: 'action',
    title: `Assign a fix version to ${ticketKey}`,
  });
  wrap.append(btn);

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // the group head opens Jira; this must not
    btn.disabled = true;
    btn.textContent = 'Loading…';
    void window.radar.listFixVersions(ticketKey).then((res) => {
      if (!res.ok || !res.versions?.length) {
        btn.textContent = res.ok ? 'No unreleased versions' : 'Failed to load';
        btn.title = res.message ?? 'The project has no unreleased versions to pick from.';
        return;
      }
      const select = document.createElement('select');
      for (const v of res.versions) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        select.append(opt);
      }
      select.addEventListener('click', (ev) => ev.stopPropagation());
      const assign = createButton('Assign', { variant: 'action' });
      assign.addEventListener('click', (ev) => {
        ev.stopPropagation();
        assign.disabled = true;
        assign.textContent = 'Assigning…';
        void window.radar.setFixVersion(ticketKey, select.value).then((r) => {
          if (!r.ok) {
            assign.textContent = 'Failed';
            assign.title = r.message;
            assign.disabled = false;
            return;
          }
          // Done: drop the select, and confirm in green — the assignment
          // succeeded, so nothing here should still read as an alarm.
          const done = el('span', 'fixversion-done', 'Assigned ✓');
          done.title = r.message;
          select.remove();
          assign.replaceWith(done);
        });
      });
      btn.replaceWith(select, assign);
    });
  });
  return wrap;
};

const renderRow = (
  item: UiItem,
  opts: { eye?: boolean; sideExtra?: HTMLElement } = {},
): HTMLElement => {
  // Clicking the row opens the MR and clears its unread mark. Buttons and chips
  // inside stop propagation so they don't also trigger this.
  const row = createRow({
    unread: item.unread,
    onClick: () => {
      void window.radar.markRead(item.key);
      void window.radar.openUrl(item.url);
    },
  });

  row.root.dataset.mrKey = item.key;
  row.main.append(el('div', 'row-title', item.title));
  // The most important thing to do for this row — plus an optional second,
  // independent signal ("Checks passed" + "Target not main").
  if (item.attentionExtra) {
    const line = el('div', 'attention');
    line.append(el('span', `attention-part attention-${item.attention.tone}`, item.attention.text));
    line.append(el('span', `attention-part attention-${item.attentionExtra.tone}`, item.attentionExtra.text));
    row.main.append(line);
  } else {
    row.main.append(el('div', `attention attention-${item.attention.tone}`, item.attention.text));
  }

  row.meta.append(el('span', undefined, `${shortProject(item.projectPath)}!${item.iid}`));
  if (item.reason === 'reviewer') row.meta.append(createBadge('your review', 'accent'));
  if (item.reason === 'participating') {
    row.meta.append(createBadge(item.participation === 'mentioned' ? 'mentioned' : 'you commented', 'accent'));
  }
  if (!isMainline(item.targetBranch)) {
    row.meta.append(
      createBadge(`→ ${item.targetBranch}`, 'warn', `This ${mr()} targets ${item.targetBranch}, not main`),
    );
  }
  if (item.draft) row.meta.append(createBadge('draft', 'muted'));
  if (item.hasConflicts) row.meta.append(createBadge('conflict', 'bad'));
  if (item.unresolved > 0) {
    row.meta.append(el('span', undefined, `${item.unresolved} unresolved`));
  }
  if (item.approvals) {
    const { required, left, by } = item.approvals;
    // GitHub can't always report a required count; degrade to a plain tally.
    const label =
      required !== undefined && left !== undefined
        ? `${required - left}/${required} approved`
        : `${by.length} approved`;
    row.meta.append(el('span', undefined, label));
  }
  if (item.overdue) row.meta.append(createBadge('overdue', 'bad'));
  // Secondary (non-gate) suites, e.g. rocket's auto-started frontend. Shown so
  // a green frontend run is never mistaken for the spec gate. Stale = the run
  // was for an older commit.
  for (const check of item.checks.filter((c) => c.role !== 'tests')) {
    const mark = check.state === 'succeeded' ? '✓' : check.state === 'failed' ? '✕' : '…';
    const tone = check.stale ? 'muted' : check.state === 'succeeded' ? 'good' : check.state === 'failed' ? 'bad' : 'muted';
    row.meta.append(
      createBadge(
        `${shortCheckName(check.name)} ${mark}`,
        tone,
        `${check.name}: ${check.state}${check.stale ? ' (older commit)' : ''} — not the spec gate`,
      ),
    );
  }
  row.main.append(row.meta);

  row.side.append(ciChip(item));
  if (item.ci.detail) row.side.append(el('span', 'chip-detail', item.ci.detail));
  const runControl = rwxRunControl(item);
  if (runControl) row.side.append(runControl);
  // A ticket-level action handed down by the group (the fix-version picker),
  // stacked under the CI chip like every other action on the row.
  if (opts.sideExtra) row.side.append(opts.sideExtra);
  if (item.reason === 'participating' && !item.ignored) row.side.append(becomeReviewerButton(item));
  if (item.slackReady && !item.ignored) row.side.append(slackButton(item));
  if (opts.eye !== false) row.side.append(eyeControl([item], !item.ignored));

  return row.root;
}

/**
 * The ignore toggle, drawn as an eye: open = watching (click to ignore),
 * closed = ignored (click to restore). Lives on the ticket header line for
 * grouped MRs and on the row for section lists.
 */
const eyeControl = (
  items: { key: string; ignored?: UiItem['ignored'] }[],
  ignore: boolean,
): HTMLElement => {
  const btn = el('button', 'eye-btn');
  btn.type = 'button';
  const byRule = items.some((i) => i.ignored === 'rule');
  btn.title = ignore
    ? items.length > 1
      ? `Ignore this ticket's ${items.length} ${mrs()} until they close — no notifications, no counts`
      : `Ignore this ${mr()} until it closes — no notifications, no counts`
    : byRule
      ? `A status rule ignores this ${mr()} — pin it visible without editing the rule`
      : `Stop ignoring this ${mr()}`;
  btn.append(eyeIcon(ignore)); // the eye shows the CURRENT state's affordance
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.disabled = true;
    // Sequential, and re-enabled on failure — a dead disabled eye with no
    // story would strand the remaining MRs half-toggled.
    void (async () => {
      for (const i of items) await window.radar.setIgnored(i.key, ignore);
    })().catch(() => {
      btn.disabled = false;
    });
  });
  return btn;
};

/**
 * Copy-for-Slack: re-check this MR with fresh data, then copy the announce
 * message. The click is the source of truth — the button's presence is only a
 * hint from the last snapshot.
 */
const slackButton = (item: UiItem): HTMLElement => {
  const btn = createButton('Copy for Slack', {
    variant: 'action',
    title: `Re-check this ${mr()} fresh, then copy the review announcement`,
  });
  // The 'action' class is alarm-red for "Start run"; announcing is a calm,
  // positive act — recolor to the accent (and green once copied).
  btn.classList.add('slack-copy');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = 'Checking…';
    void window.radar.checkReviewReady(item.key).then(async (r) => {
      if (r.ok && r.eligible && r.message) {
        const message = r.message;
        const messageHtml = r.messageHtml;
        // The tray copies in the main process before resolving — the popover
        // may not survive the re-check, so the write cannot live here. Only
        // the web page (no main process) still copies from the renderer.
        const copied = r.copied ?? (await window.radar.copyText(message, messageHtml));
        btn.title = message; // hover shows exactly what will be / was copied
        if (copied) {
          btn.textContent = 'Copied ✓';
          btn.classList.add('copied');
          return;
        }
        // Browser clipboard writes need user activation, which the seconds of
        // re-checking consumed. The NEXT click has fresh activation: copy
        // directly, no re-check.
        btn.textContent = 'Click to copy';
        btn.disabled = false;
        btn.addEventListener(
          'click',
          (e2) => {
            e2.stopPropagation();
            void window.radar.copyText(message, messageHtml).then((ok) => {
              btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
              if (ok) btn.classList.add('copied');
              btn.disabled = true;
            });
          },
          { once: true },
        );
        return;
      }
      // Not eligible after all (or the check failed): say why, right here.
      btn.textContent = 'Not ready';
      const why = r.reasons?.length ? r.reasons : [r.message ?? 'Could not verify.'];
      btn.title = why.join('\n');
      const note = el('span', 'chip-detail slack-why', why[0] ?? '');
      note.title = why.join('\n');
      btn.insertAdjacentElement('afterend', note);
    }).catch((err: unknown) => {
      // A rejected IPC/fetch must not leave the button dead with no story.
      btn.textContent = 'Check failed';
      btn.title = err instanceof Error ? err.message : String(err);
      btn.disabled = false;
    });
  });
  return btn;
};

const ciChip = (item: UiItem): HTMLElement => {
  const chip = createChip(item.ci.label, item.ci.tone);
  const url = item.ci.url;
  if (url) {
    chip.classList.add('clickable');
    chip.title = `Open in ${item.ci.provider === 'rwx' ? 'RWX' : 'GitLab'}`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      void window.radar.openUrl(url);
    });
  }
  return chip;
}

/**
 * The RWX run control, derived from the gate so it tracks state on every poll:
 *  - startable        → "Start run" (triggers a run, asks first)
 *  - running + url     → "Current run" (opens the run page on click)
 *  - anything else     → nothing (the chip already shows passed/failed/none)
 *
 * Because it's rebuilt from the gate each render, a new push — which moves the
 * head past the run and flips the gate back to startable — automatically
 * reverts "Current run" to "Start run". RWX only: GitLab pipelines aren't ours
 * to start, and their chip is already a link.
 */
const rwxRunControl = (item: UiItem): HTMLElement | null => {
  if (item.ci.provider !== 'rwx') return null;
  if (item.ci.startable) return startButton(item);
  if (item.ci.tone === 'busy' && item.ci.url) return currentRunButton(item.ci.url);
  return null;
}

const currentRunButton = (url: string): HTMLElement => {
  const btn = createButton('Current run', { variant: 'action', title: 'Open the running build' });
  btn.classList.add('current-run');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void window.radar.openUrl(url);
  });
  return btn;
}

/**
 * The trigger. Starts as "Start run"; on a successful start it flips in place to
 * "Current run" (opening the run on click, not auto-opening a tab). The next
 * poll re-renders this from the gate — which, thanks to the watched-run bridge,
 * also reads "Current run" — so there's no flicker back to "Start run" while the
 * run is live.
 */
const startButton = (item: UiItem): HTMLElement => {
  const btn = createButton('Start run', {
    variant: 'action',
    title: `Start a run for ${item.branch} @ ${item.headSha.slice(0, 8)} (asks first)`,
  });
  let runUrl: string | undefined;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (runUrl) {
      void window.radar.openUrl(runUrl);
      return;
    }
    // Click → instantly "Starting…" in the accent fill; the rwx CLI takes a
    // couple of seconds to create the run. On resolve the button becomes
    // "Current run" and main pushes the snapshot whose gate reads running.
    btn.disabled = true;
    btn.textContent = 'Starting…';
    btn.classList.add('starting');
    void window.radar.startRun(item.key).then((result) => {
      btn.classList.remove('starting');
      if (result.started && result.url) {
        runUrl = result.url;
        btn.textContent = 'Current run';
        btn.title = 'Open the running build';
        btn.classList.add('current-run');
        btn.disabled = false;
      } else if (result.started) {
        btn.textContent = 'Started';
        btn.title = result.message;
        btn.disabled = true;
      } else {
        btn.textContent = 'Start run';
        btn.disabled = false;
        if (result.message !== 'Cancelled.') btn.title = result.message;
      }
    });
  });
  return btn;
}

// -- settings panel ---------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toggleSettings = async (): Promise<void> => {
  if (settingsEl.hidden) await openSettings();
  else closeSettings();
}

const closeSettings = (): void => {
  // Drop any unsaved theme preview.
  void window.radar.getSettings().then((s) => applyTheme(s.theme, s.appearance));
  settingsEl.hidden = true;
  settingsEl.replaceChildren();
}

/**
 * Build the settings form from the live config. Rebuilt each open so it always
 * reflects what's on disk; edits only take effect on Save.
 */
const openSettings = async (): Promise<void> => {
  // Cover the list BEFORE fetching: the round-trip is milliseconds, but even
  // one visible frame of the main UI reads as a flash when the user asked
  // for Settings. The overlay's solid background stands in until data lands.
  settingsEl.replaceChildren();
  settingsEl.hidden = false;
  const [s, launchAtLogin] = await Promise.all([
    window.radar.getSettings(),
    window.radar.getLaunchAtLogin(),
  ]);

  const head = el('div', 'settings-head');
  head.append(el('h2', undefined, 'Settings'));
  const closeBtn = el('button', 'link', 'Done');
  closeBtn.addEventListener('click', closeSettings);
  head.append(closeBtn);

  const form = el('div', 'settings-form');

  const atlassianUrl = textField('Atlassian URL', s.jiraBaseUrl, 'https://your-org.atlassian.net');
  const email = textField('Jira email', s.jiraEmail, 'you@company.com');
  // Status → section assignment: one multi-select per section. Clicking a
  // field opens a checklist of every status ever seen on tracked tickets
  // (persisted in the local DB); picked statuses render as chips. A status
  // lives in exactly one section — picking it elsewhere moves it; unpicked
  // everywhere means the default Other bucket.
  const SECTION_FIELDS: { key: StatusSection; label: string }[] = [
    { key: 'active', label: 'Active (watch list)' },
    { key: 'verification', label: 'Verification' },
    { key: 'done', label: 'Done' },
    { key: 'ignore', label: 'Hide (never show)' },
  ];
  const assignments = new Map<string, { status: string; section: StatusSection }>();
  const knownStatusNames = new Map<string, string>(); // lowercase → display casing
  const NO_TICKET = '(no ticket)'; // mirrors NO_TICKET_STATUS in core config
  const ANY_STATUS = '(any status)'; // mirrors ANY_STATUS in core config
  const learnStatus = (status: string): void => {
    if (status === NO_TICKET || status === ANY_STATUS) return; // sentinels, not Jira statuses

    if (status && !knownStatusNames.has(status.toLowerCase())) {
      knownStatusNames.set(status.toLowerCase(), status);
    }
  };
  for (const a of s.statusAssignments) {
    learnStatus(a.status);
    if (a.section !== 'other') assignments.set(a.status.toLowerCase(), { status: a.status, section: a.section });
  }

  // "My-ticket fields": which Jira fields make a ticket yours. Selection is a
  // clause→label map; the panel lists the site's real user-valued fields.
  const ownerSel = new Map<string, string>();
  for (const f of s.ownerFields) ownerSel.set(f.clause, f.label || f.clause);
  let ownerChoices: { clause: string; label: string }[] = [];
  let ownerFetchError = '';
  const ownerWrap = el('div', 'field msf');
  ownerWrap.append(el('span', 'field-label', 'My-ticket fields'));
  ownerWrap.title = 'A ticket is yours when any of these fields names you (field = currentUser() in the scope query)';
  const ownerBox = el('div', 'msf-box');
  const ownerPanel = el('div', 'msf-panel');
  registerDropdown(ownerBox, ownerPanel);
  const paintOwner = (): void => {
    ownerBox.replaceChildren();
    if (ownerSel.size === 0) ownerBox.append(el('span', 'msf-placeholder', 'Click to choose fields…'));
    for (const [clause, label] of ownerSel) {
      ownerBox.append(
        createRemovableChip(label, {
          removeTitle: `Tickets where ${label} names you will no longer count as yours`,
          onRemove: (e) => {
            e.stopPropagation();
            if (ownerSel.size === 1) return; // empty scope is not savable anyway
            ownerSel.delete(clause);
            paintOwner();
          },
        }),
      );
    }
    ownerPanel.replaceChildren();
    const known = new Map(ownerChoices.map((f) => [f.clause, f.label]));
    for (const [clause, label] of ownerSel) if (!known.has(clause)) known.set(clause, label);
    for (const [clause, label] of [...known.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      const row = el('div', 'msf-row');
      row.append(el('span', undefined, label));
      if (ownerSel.has(clause)) row.append(el('span', 'msf-row-check', '✓'));
      row.addEventListener('click', () => {
        if (ownerSel.has(clause)) {
          if (ownerSel.size === 1) return;
          ownerSel.delete(clause);
        } else {
          ownerSel.set(clause, label);
        }
        paintOwner();
      });
      ownerPanel.append(row);
    }
    if (ownerFetchError) {
      ownerPanel.append(el('div', 'msf-row msf-placeholder', `Connect Jira to list more fields (${ownerFetchError})`));
    }
  };
  paintOwner();
  ownerWrap.append(ownerBox, ownerPanel);
  void window.radar.listOwnerFields().then((res) => {
    if (res.ok && res.fields) ownerChoices = res.fields;
    else ownerFetchError = res.message ?? 'unavailable';
    paintOwner();
  });

  const statusBlock = el('div', 'status-sections');
  statusBlock.append(el('div', 'field-label', 'Jira status sections'));
  const repaints: (() => void)[] = [];
  const repaintAll = (): void => repaints.forEach((fn) => fn());

  const multiStatusField = (key: StatusSection, label: string): HTMLElement => {
    const wrap = el('div', 'field msf');
    wrap.append(el('span', 'field-label', label));
    const box = el('div', 'msf-box');
    const panel = el('div', 'msf-panel');
    registerDropdown(box, panel);

    const paint = (): void => {
      box.replaceChildren();
      const mine = [...assignments.values()].filter((a) => a.section === key);
      if (mine.length === 0) box.append(el('span', 'msf-placeholder', 'Click to choose statuses…'));
      for (const a of mine) {
        box.append(
          createRemovableChip(a.status, {
            removeTitle: `Remove ${a.status} (falls back to the Other section)`,
            onRemove: (e) => {
              e.stopPropagation();
              assignments.delete(a.status.toLowerCase());
              repaintAll();
            },
          }),
        );
      }

      panel.replaceChildren();
      const names = [...knownStatusNames.values()].sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const current = assignments.get(name.toLowerCase())?.section;
        const row = el('div', 'msf-row');
        row.append(el('span', undefined, name));
        if (current === key) row.append(el('span', 'msf-row-check', '✓'));
        else if (current) row.append(el('span', 'msf-row-where', SECTION_FIELDS.find((f) => f.key === current)?.label ?? current));
        row.addEventListener('click', () => {
          if (current === key) assignments.delete(name.toLowerCase());
          else assignments.set(name.toLowerCase(), { status: name, section: key });
          repaintAll();
        });
        panel.append(row);
      }
    };
    repaints.push(paint);
    paint();
    wrap.append(box, panel);
    return wrap;
  };
  for (const f of SECTION_FIELDS) statusBlock.append(multiStatusField(f.key, f.label));
  void window.radar.listStatuses().then((res) => {
    for (const st of res.statuses ?? []) learnStatus(st);
    repaintAll();
  });

  /**
   * A plain chip multi-select over the known statuses, for settings that name
   * statuses independently of the section assignments — an MR can be
   * announceable, or expected, whichever section its status renders in.
   * `selected` is keyed by lowercase status, valued by display casing.
   */
  const statusChipField = (
    label: string,
    selected: Map<string, string>,
    removeTitle: (status: string) => string,
  ): HTMLElement => {
    const wrap = el('div', 'field msf');
    wrap.append(el('span', 'field-label', label));
    const box = el('div', 'msf-box');
    const panel = el('div', 'msf-panel');
    registerDropdown(box, panel);
    const paint = (): void => {
      box.replaceChildren();
      if (selected.size === 0) box.append(el('span', 'msf-placeholder', 'Click to choose statuses…'));
      for (const status of selected.values()) {
        box.append(
          createRemovableChip(status, {
            removeTitle: removeTitle(status),
            onRemove: (e) => {
              e.stopPropagation();
              selected.delete(status.toLowerCase());
              paint();
            },
          }),
        );
      }
      panel.replaceChildren();
      for (const name of [...knownStatusNames.values()].sort((a, b) => a.localeCompare(b))) {
        const row = el('div', 'msf-row');
        row.append(el('span', undefined, name));
        if (selected.has(name.toLowerCase())) row.append(el('span', 'msf-row-check', '✓'));
        row.addEventListener('click', () => {
          if (selected.has(name.toLowerCase())) selected.delete(name.toLowerCase());
          else selected.set(name.toLowerCase(), name);
          paint();
        });
        panel.append(row);
      }
    };
    // Statuses arrive asynchronously (listStatuses); repaint when they land.
    repaints.push(paint);
    paint();
    wrap.append(box, panel);
    return wrap;
  };

  // The advanced rule builder, in one place for both rule kinds: "for <status>
  // [in <repo>], when <field> <op> (<value>) → <target>, else <target>".
  // Section routing (statusRules) and MR expectations (noMr.rules) share the
  // whole card — they differ only in their target vocabulary, whether a repo
  // scope applies, and what the special entry atop the status list means.
  const mkSelect = (options: string[], value: string): ReturnType<typeof createSelect> =>
    createSelect(options, value);

  interface RuleListOpts {
    /** Collapsed-header text; the rule count is appended. */
    label: string;
    title: string;
    rules: EditableRule[];
    /**
     * The non-status entry offered first. `bare` marks it as inherently
     * unconditional — '(no ticket)' has no ticket fields to test, while
     * '(any status)' is just a wildcard and stays fully conditional.
     */
    sentinel: { value: string; bare: boolean };
    /** Repos offered as a scope; omitted = the rule has no repo line at all. */
    repoChoices?: string[];
    /** Targets for then/else, given the rule's effective op. */
    targets: (op: string) => string[];
    /** The rule a fresh "Add rule" click starts from. */
    blank: () => EditableRule;
  }

  const buildRuleList = (opts: RuleListOpts): { block: HTMLElement; collect: () => EditableRule[] } => {
  const rulesBlock = el('div', 'status-sections');
  const rulesHead = el('button', 'other-header');
  rulesHead.type = 'button';
  rulesHead.title = opts.title;
  const rulesBody = el('div');
  const ruleRowsWrap = el('div', 'rule-rows');
  let rulesCollapsed = true;
  interface RuleRow {
    root: HTMLElement;
    get: () => EditableRule;
  }
  const ruleRows: RuleRow[] = [];
  const paintRulesHead = (): void => {
    rulesHead.textContent = `${rulesCollapsed ? '▸' : '▾'}  ${opts.label} (${ruleRows.length})`;
    rulesBody.hidden = rulesCollapsed;
  };
  rulesHead.addEventListener('click', () => {
    rulesCollapsed = !rulesCollapsed;
    paintRulesHead();
  });

  const addRuleRow = (r: EditableRule, after?: HTMLElement): void => {
    learnStatus(r.status);
    const root = el('div', 'rule-row');
    // The sentinel leads the list, then every known status.
    const status = createSelect(
      [opts.sentinel.value, ...[...knownStatusNames.values()].sort((a, b) => a.localeCompare(b))],
      r.status,
    );
    /** True when this rule can't be conditional (see RuleListOpts.sentinel). */
    const sentinelBare = (): boolean => opts.sentinel.bare && status.select.value === opts.sentinel.value;
    // Repo scope: '' = any repo; the list is what the radar actually tracks.
    const repoChoices = [...new Set([...(opts.repoChoices ?? []), ...(r.repo ? [r.repo] : [])])];
    const repo = opts.repoChoices
      ? createSelect(
          [
            { value: '', label: 'any repo' },
            ...repoChoices.map((path) => ({ value: path, label: shortProject(path), title: path })),
          ],
          r.repo ?? '',
        )
      : undefined;
    const field = mkSelect(s.ruleFieldChoices, r.field);
    // 'always' is not an op you pick — it's the state of a rule whose whole
    // when-clause has been removed (× on the when line brings it here).
    let whenRemoved = r.op === 'always';
    const condOpChoices = s.ruleOpChoices.filter((o) => o !== 'always');
    const op = mkSelect(condOpChoices, r.op === 'always' ? 'empty' : r.op);
    const effectiveOp = (): string => (whenRemoved ? 'always' : op.select.value);
    const value = el('input', 'field-input rule-value');
    value.type = 'text';
    value.value = r.value ?? '';
    value.placeholder = 'regex';
    value.title = "Case-insensitive regular expression — e.g. 'data ?fix' matches DataFix and Data Fix";
    const thenSel = mkSelect(opts.targets(r.op), r.then);
    const elseSel = mkSelect(opts.targets(r.op), r.else || 'next');

    // Chained extra conditions, data_set_filter style: each line carries its
    // own and/or connector and folds onto the when-check left to right.
    const alsoWrap = el('div', 'rule-also');
    interface CondRow {
      root: HTMLElement;
      connector: ReturnType<typeof createSelect>;
      field: ReturnType<typeof createSelect>;
      op: ReturnType<typeof createSelect>;
      value: HTMLInputElement;
    }
    const condRows: CondRow[] = [];
    const addCondRow = (c: { connector: string; field: string; op: string; value: string }): void => {
      const connector = createSelect(['and', 'or'], c.connector || 'and');
      const cField = mkSelect(s.ruleFieldChoices, c.field || 'issueType');
      const cOp = mkSelect(condOpChoices, condOpChoices.includes(c.op) ? c.op : 'matches');
      const cValue = el('input', 'field-input rule-value');
      cValue.type = 'text';
      cValue.value = c.value ?? '';
      cValue.placeholder = 'regex';
      cValue.title = "Case-insensitive regular expression — e.g. 'data ?fix' matches DataFix and Data Fix";
      const syncCValue = (): void => {
        cValue.hidden = cOp.select.value !== 'matches';
      };
      cOp.select.addEventListener('change', syncCValue);
      syncCValue();
      const condRoot = el('div', 'rule-line rule-branch');
      const removeCond = createButton('×', {
        variant: 'link',
        title: 'Remove this condition',
        onClick: () => {
          condRoot.remove();
          condRows.splice(condRows.findIndex((x) => x.root === condRoot), 1);
        },
      });
      condRoot.append(connector.root, cField.root, cOp.root, cValue, removeCond);
      condRows.push({ root: condRoot, connector, field: cField, op: cOp, value: cValue });
      alsoWrap.append(condRoot);
    };
    for (const c of r.also ?? []) addCondRow(c);
    const addCond = createButton('+ condition', {
      variant: 'link',
      title: 'Chain another check onto the when-clause (and/or)',
      onClick: () => addCondRow({ connector: 'and', field: 'issueType', op: 'matches', value: '' }),
    });
    const addCondLine = el('div', 'rule-line rule-branch');
    addCondLine.append(addCond);

    const syncValue = (): void => {
      value.hidden = op.select.value !== 'matches';
      const allowed = opts.targets(effectiveOp());
      for (const sel of [thenSel, elseSel]) {
        // A target the current op no longer offers (e.g. 'needs-value' outside
        // an empty-check) falls back to 'next' rather than silently persisting.
        if (!allowed.includes(sel.select.value)) {
          sel.select.value = 'next';
          sel.select.dispatchEvent(new Event('change'));
        }
        sel.setOptions(allowed);
      }
    };
    op.select.addEventListener('change', syncValue);
    syncValue();
    const snapshotRule = (): EditableRule => ({
      status: status.select.value,
      repo: repo?.select.value ?? '',
      field: whenRemoved || sentinelBare() ? '' : field.select.value,
      op: sentinelBare() ? 'always' : effectiveOp(),
      value: value.value,
      also:
        whenRemoved
          ? []
          : condRows.map((c) => ({
              connector: c.connector.select.value,
              field: c.field.select.value,
              op: c.op.select.value,
              value: c.value.value,
            })),
      then: thenSel.select.value,
      else: elseSel.select.value,
    });
    const clone = createButton('⧉', {
      title: 'Clone this rule (inserts right below)',
      onClick: () => addRuleRow(snapshotRule(), root),
    });
    clone.classList.add('rule-clone');
    const remove = createButton('×', {
      variant: 'destructive',
      title: 'Remove rule',
      onClick: () => {
        root.remove();
        ruleRows.splice(ruleRows.findIndex((x) => x.root === root), 1);
        paintRulesHead();
      },
    });
    remove.classList.add('rule-remove'); // far right, centered on the rule
    // The rule reads as a five-line sentence:
    //   <status> in <repo>
    //   when <field> <op> [<value>]
    //     → <target>
    //   else
    //     → <target>
    const line = (cls: string, ...kids: (HTMLElement | string)[]): HTMLElement => {
      const d = el('div', cls ? `rule-line ${cls}` : 'rule-line');
      d.append(...kids.map((k) => (typeof k === 'string' ? el('span', 'rule-word', k) : k)));
      return d;
    };
    // Rules are order-sensitive ('next' falls through), so cards can be
    // dragged into a new order by their grip. The DOM order IS the saved
    // order — collection reads children, not insertion order.
    const grip = el('span', 'rule-grip', '⠿');
    grip.title = 'Drag to reorder — rules run top to bottom';
    grip.addEventListener('mousedown', () => {
      root.draggable = true;
    });
    root.addEventListener('dragstart', (e) => {
      root.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', '');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    root.addEventListener('dragend', () => {
      root.classList.remove('dragging');
      root.draggable = false;
    });
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = ruleRowsWrap.querySelector('.dragging');
      if (!dragging || dragging === root) return;
      const rect = root.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      ruleRowsWrap.insertBefore(dragging, before ? root : root.nextSibling);
    });
    const controls = el('div', 'rule-controls');
    const whenWord = el('span', 'rule-word', 'when');
    const whenLine = el('div', 'rule-line');
    const removeWhen = createButton('×', {
      variant: 'link',
      title: 'Remove the condition — the rule then always applies',
      onClick: () => {
        whenRemoved = true;
        syncStructure();
        syncValue();
      },
    });
    whenLine.append(whenWord, field.root, op.root, value, removeWhen);
    const addWhen = createButton('+ when', {
      variant: 'link',
      title: 'Add a condition to this rule',
      onClick: () => {
        whenRemoved = false;
        syncStructure();
        syncValue();
      },
    });
    const addWhenLine = el('div', 'rule-line');
    addWhenLine.append(addWhen);
    const elseWordLine = line('', 'else');
    const removeElse = createButton('×', {
      variant: 'link',
      title: 'Remove the else branch — the rule falls through instead',
      onClick: () => {
        elseSel.select.value = 'next';
        elseSel.select.dispatchEvent(new Event('change'));
      },
    });
    const elseLine = line('rule-branch', '→', elseSel.root, removeElse);
    // No else is the default state — it means 'next' (fall through). "+ else"
    // adds a branch; picking 'next' in its dropdown removes it again.
    const addElse = createButton('+ else', {
      variant: 'link',
      title: "Add an else branch — without one the rule falls through ('next')",
      onClick: () => {
        elseSel.select.value = 'other';
        elseSel.select.dispatchEvent(new Event('change'));
      },
    });
    const addElseLine = el('div', 'rule-line');
    addElseLine.append(addElse);
    controls.append(
      repo ? line('', status.root, 'in', repo.root) : line('', status.root),
      whenLine,
      addWhenLine,
      alsoWrap,
      addCondLine,
      line('rule-branch', '→', thenSel.root),
      elseWordLine,
      elseLine,
      addElseLine,
    );
    // An unconditional rule reads as just "<status> in <repo> → <target>":
    // no field, no conditions, no else — only the op select stays as the way
    // back. For conditional rules, the else block only renders when one exists.
    const syncStructure = (): void => {
      const bare = whenRemoved || sentinelBare();
      const hasElse = elseSel.select.value !== 'next';
      whenLine.hidden = bare;
      addWhenLine.hidden = !whenRemoved || sentinelBare();
      alsoWrap.hidden = bare;
      addCondLine.hidden = bare;
      elseWordLine.hidden = bare || !hasElse;
      elseLine.hidden = bare || !hasElse;
      addElseLine.hidden = bare || hasElse;
    };
    status.select.addEventListener('change', syncStructure);
    elseSel.select.addEventListener('change', syncStructure);
    syncStructure();
    root.append(grip, controls, clone, remove);
    if (after) ruleRowsWrap.insertBefore(root, after.nextSibling);
    else ruleRowsWrap.append(root);
    ruleRows.push({ root, get: snapshotRule });
    paintRulesHead();
  };
  for (const r of opts.rules) addRuleRow(r);
  const addRuleBtn = el('button', undefined, 'Add rule');
  addRuleBtn.type = 'button';
  addRuleBtn.addEventListener('click', () => {
    rulesCollapsed = false;
    addRuleRow(opts.blank());
  });
  rulesBody.append(ruleRowsWrap, addRuleBtn);
  rulesBlock.append(rulesHead, rulesBody);
  paintRulesHead();
  // Saved order = on-screen order: rows may have been drag-reordered, so the
  // DOM is the source of truth, not insertion order.
  const collect = (): EditableRule[] =>
    [...ruleRowsWrap.children]
      .map((rowEl) => ruleRows.find((x) => x.root === rowEl))
      .filter((x): x is RuleRow => x !== undefined)
      .map((x) => x.get());
  return { block: rulesBlock, collect };
  };

  const routingRules = buildRuleList({
    label: 'Advanced: conditional rules',
    title:
      'Route a status conditionally, before the plain section mapping. Rules run top to bottom; ' +
      "'next' falls through to the next rule.",
    rules: s.statusRules,
    sentinel: { value: NO_TICKET, bare: true },
    repoChoices: s.ruleRepoChoices ?? [],
    // 'needs-value' only means something for an empty-check; other ops hide it.
    targets: (op) =>
      op === 'empty' ? s.ruleTargetChoices : s.ruleTargetChoices.filter((c) => c !== 'needs-value'),
    blank: () => ({
      status: [...knownStatusNames.values()][0] ?? '',
      field: 'fixVersions',
      op: 'empty',
      value: '',
      also: [],
      then: 'active',
      else: 'next',
    }),
  });

  // Tickets with no MR at all: the switch, the statuses where that's a problem
  // rather than a fact, and the rules that decide it case by case.
  const noMrEnabled = checkboxField(`Show active tickets that have no ${mr()}`, s.noMrEnabled !== false);
  noMrEnabled.wrap.title =
    `Every row in this app starts from a ${mr()}, so a ticket you have not pushed a branch for is otherwise invisible.`;
  const expectSet = new Map<string, string>(); // lowercase → display casing
  for (const st of s.noMrExpectStatuses ?? []) {
    learnStatus(st);
    expectSet.set(st.toLowerCase(), st);
  }
  const expectWrap = statusChipField(
    `Statuses where a ${mr()} is expected`,
    expectSet,
    (st) => `A missing ${mr()} at ${st} becomes a plain note again, not a warning`,
  );
  expectWrap.title =
    `At these statuses a missing ${mr()} is a warning. Everywhere else it is a muted note — visible, not nagging.`;
  const noMrRules = buildRuleList({
    label: `Advanced: which tickets need a ${mr()}`,
    title:
      "Decide per ticket whether an MR is expected. 'exempt' drops the row entirely (spikes, research), " +
      "'expect' warns even at a status not listed above.",
    rules: s.noMrRules ?? [],
    // '(any status)' is a wildcard, not a bare rule: the conditions still apply.
    sentinel: { value: ANY_STATUS, bare: false },
    targets: () => s.mrRuleTargetChoices ?? ['expect', 'exempt', 'next'],
    blank: () => ({
      status: ANY_STATUS,
      field: 'issueType',
      op: 'matches',
      value: '',
      also: [],
      then: 'exempt',
      else: 'next',
    }),
  });
  const noMrBlock = el('div', 'status-sections');
  noMrBlock.append(el('div', 'field-label', `Tickets without a ${mr()}`), noMrEnabled.wrap);
  const noMrBody = el('div', 'settings-sub');
  noMrBody.append(expectWrap, noMrRules.block);
  noMrBlock.append(noMrBody);
  const syncNoMr = (): void => {
    noMrBody.style.display = noMrEnabled.input.checked ? '' : 'none';
  };
  noMrEnabled.input.addEventListener('change', syncNoMr);
  syncNoMr();
  const recent = numberField(`Also watch ${mrs()} updated within N days (0 = active tickets only)`, s.recentDaysFallback);
  const pollSecs = numberField('Poll every N seconds', s.pollBaseSeconds);

  const notify = checkboxField('Show notifications', s.notificationsEnabled);
  const sound = selectField('Notification sound', s.soundChoices, s.notificationSound);
  const method = selectField('Notification method', s.methodChoices, s.notificationMethod);
  method.select.title =
    'auto = osascript (always delivers). terminal-notifier adds icon + click-to-open but needs ThreatLocker approval — explicit opt-in only. native = Electron (needs a signed app).';
  const updateStyle = selectField('Branch update style', s.updateStyleChoices, s.updateStyle);
  const forgeSel = selectField('Forge', s.forgeChoices, s.forge);
  forgeSel.select.title =
    "Where your MRs/PRs live. 'auto' detects from which CLI (glab/gh) is authenticated" +
    (s.activeForge ? ` — currently using ${s.activeForge}` : '');
  const rwxEnabled = checkboxField('Use RWX for CI status (requires the rwx CLI)', s.rwxEnabled);
  updateStyle.select.title =
    'How you bring main into a branch. Adjusts guidance text: conflicts say "needs a rebase" vs "merge main into the branch".';
  const theme = selectField('Theme', s.themeChoices, s.theme);
  theme.select.title = 'Color palette. Every theme has a light and a dark half.';
  const appearance = selectField('Appearance', s.appearanceChoices, s.appearance);
  appearance.select.title = "Which half of the theme applies: follow the OS, or pin light/dark.";
  // Preview live — Save persists, closing without saving reverts on next open.
  const previewTheme = (): void => applyTheme(theme.select.value, appearance.select.value);
  theme.select.addEventListener('change', previewTheme);
  appearance.select.addEventListener('change', previewTheme);

  // Launch-at-login is an OS setting, not part of config.json, so it applies
  // immediately on toggle rather than waiting for Save.
  const login = checkboxField('Launch at login', launchAtLogin);
  login.input.addEventListener('change', () => {
    void window.radar.setLaunchAtLogin(login.input.checked).then((actual) => {
      login.input.checked = actual;
    });
  });

  // Active hours
  const hoursEnabled = checkboxField('Only poll during active hours', s.activeHours.enabled);
  const dayToggles = WEEKDAYS.map((name, i) => {
    const on = s.activeHours.days.includes(i);
    const b = el('button', on ? 'day on' : 'day', name);
    b.type = 'button';
    b.dataset.day = String(i);
    b.addEventListener('click', () => b.classList.toggle('on'));
    return b;
  });
  const daysRow = el('div', 'settings-days');
  daysRow.append(...dayToggles);
  const start = textField('From', s.activeHours.start, '08:00');
  const end = textField('To', s.activeHours.end, '19:00');
  const timesRow = el('div', 'settings-times');
  timesRow.append(start.wrap, end.wrap);

  const hoursBlock = el('div', 'settings-sub');
  hoursBlock.append(daysRow, timesRow);
  const syncHours = (): void => {
    hoursBlock.style.display = hoursEnabled.input.checked ? '' : 'none';
  };
  hoursEnabled.input.addEventListener('change', syncHours);
  syncHours();

  // One row per repo the app has seen: a checkout path (enables the RWX
  // Start-run trigger) and a test-gate pin — 'auto' detects from live data;
  // pin 'gitlab'/'none' only when detection gets a repo wrong.
  const repoFields = s.repos.map((r) => {
    const row = el('div', 'repo-row');
    const checkout = textField(`${r.projectPath} checkout`, r.checkout, '/Users/you/code/…');
    const gate = selectField('Test gate', s.repoGateChoices, r.testGate);
    row.append(checkout.wrap, gate.wrap);
    return { projectPath: r.projectPath, rwxDefinition: r.rwxDefinition, row, checkout, gate };
  });

  // Copy for Slack: which ticket statuses make an MR announceable, and the
  // message it copies. The statuses are an independent pick-list (an MR can be
  // announceable regardless of which section its status renders in).
  for (const st of s.slackReadyStatuses) learnStatus(st);
  const readySet = new Map<string, string>(); // lowercase → display casing
  for (const st of s.slackReadyStatuses) readySet.set(st.toLowerCase(), st);
  const slackBlock = el('div', 'status-sections');
  slackBlock.append(el('div', 'field-label', 'Copy for Slack'));
  const readyWrap = statusChipField(
    'Ready-for-review statuses',
    readySet,
    (status) => `Stop offering Copy for Slack on ${status}`,
  );
  const slackTemplateField = textField(
    'Message template',
    s.slackTemplate,
    'hey team! {ticketUrl} is ready for review. {title}',
  );
  slackTemplateField.input.title = 'Placeholders: {ticketKey} {ticketUrl} {title} {mrUrl}';
  // One click inserts a named link at the cursor — or wraps the selection,
  // so "select the words, click Insert link" does what it reads like.
  const insertLink = createButton('Insert link', {
    variant: 'link',
    title: 'Insert [text](url) at the cursor — pastes into Slack as a real hyperlink',
    onClick: () => {
      const input = slackTemplateField.input;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const selected = input.value.slice(start, end);
      const snippet = `[${selected || '{ticketKey}'}]({ticketUrl})`;
      input.value = input.value.slice(0, start) + snippet + input.value.slice(end);
      const cursor = start + snippet.length;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      paintSlackPreview();
    },
  });

  const slackLegend = el('div', 'field-hint');
  slackLegend.append(
    el('span', undefined, 'Variables: '),
    el('code', undefined, '{ticketKey}'),
    el('span', undefined, ' · '),
    el('code', undefined, '{ticketUrl}'),
    el('span', undefined, ' Jira link · '),
    el('code', undefined, '{title}'),
    el('span', undefined, ` ${mr()} subject line · `),
    el('code', undefined, '{mrUrl}'),
    el('span', undefined, ' · links: '),
    el('code', undefined, '[text](url)'),
  );
  // Live preview with sample values, so the voice is auditioned before saving.
  const slackPreview = el('div', 'slack-preview');
  const paintSlackPreview = (): void => {
    const sample: Record<string, string> = {
      ticketKey: 'ENG-123',
      ticketUrl: 'https://your-org.atlassian.net/browse/ENG-123',
      title: 'Short subject line describing the work',
      mrUrl: 'https://gitlab.example.com/acme/rocket/-/merge_requests/42',
    };
    const rendered = slackTemplateField.input.value.replace(
      /\{(ticketKey|ticketUrl|title|mrUrl)\}/g,
      (_, name: string) => sample[name] ?? '',
    );
    slackPreview.replaceChildren();
    if (!rendered) return;
    // Named links render as real (inert) anchors — the preview shows what
    // Slack's composer will paste, not the raw [text](url) source.
    slackPreview.append(el('span', undefined, 'Preview: '));
    const linkRe = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0;
    for (const m of rendered.matchAll(linkRe)) {
      slackPreview.append(el('span', undefined, rendered.slice(last, m.index)));
      const a = el('a', 'slack-preview-link', m[1] ?? '');
      a.title = m[2] ?? '';
      slackPreview.append(a);
      last = (m.index ?? 0) + m[0].length;
    }
    slackPreview.append(el('span', undefined, rendered.slice(last)));
  };
  slackTemplateField.input.addEventListener('input', paintSlackPreview);
  paintSlackPreview();
  slackBlock.append(readyWrap, slackTemplateField.wrap, insertLink, slackLegend, slackPreview);

  const msg = createStatusMessage();

  // Share settings with teammates: export downloads the shareable subset
  // (email/identity stripped; the Jira token lives in the Keychain and is never
  // in config at all), import merges a teammate's file while keeping yours.
  const shareRow = el('div', 'settings-share');
  const exportBtn = el('button', undefined, 'Export settings…');
  exportBtn.addEventListener('click', () => {
    void window.radar.exportSettings().then((res) => {
      if (!res.ok || !res.settings) {
        msg.set(res.message ?? 'Export failed.', 'err');
        return;
      }
      const blob = new Blob([JSON.stringify(res.settings, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mr-radar-settings.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  });
  const importBtn = el('button', undefined, 'Import settings…');
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.hidden = true;
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      let shared: unknown;
      try {
        shared = JSON.parse(text);
      } catch {
        msg.set('That file is not valid JSON.', 'err');
        return;
      }
      void window.radar.importSettings(shared as Record<string, unknown>).then((res) => {
        msg.set(res.message, res.ok ? 'ok' : 'err');
      });
    });
    importInput.value = '';
  });
  shareRow.append(exportBtn, importBtn, importInput);

  const tabCountsSel = selectField('Tab counts', s.tabCountsChoices, s.tabCounts);
  tabCountsSel.wrap.title = "'active': count only the sections that need you; 'all': count every section shown";

  const save = createButton('Save', { variant: 'primary' });
  save.addEventListener('click', () => {
    const next: typeof s = {
      jiraEmail: email.input.value.trim(),
      jiraBaseUrl: atlassianUrl.input.value.trim(),
      ownerFields: [...ownerSel.entries()].map(([clause, label]) => ({ clause, label })),
      activeStatuses: [...assignments.values()]
        .filter((a) => a.section === 'active')
        .map((a) => a.status),
      statusAssignments: [...assignments.values()],
      sectionChoices: s.sectionChoices,
      statusRules: routingRules.collect(),
      ruleFieldChoices: s.ruleFieldChoices,
      ruleOpChoices: s.ruleOpChoices,
      ruleTargetChoices: s.ruleTargetChoices,
      ruleRepoChoices: s.ruleRepoChoices,
      noMrEnabled: noMrEnabled.input.checked,
      noMrExpectStatuses: [...expectSet.values()],
      noMrRules: noMrRules.collect(),
      mrRuleTargetChoices: s.mrRuleTargetChoices,
      recentDaysFallback: Number(recent.input.value),
      notificationsEnabled: notify.input.checked,
      notificationSound: sound.select.value,
      soundChoices: s.soundChoices,
      notificationMethod: method.select.value,
      methodChoices: s.methodChoices,
      updateStyle: updateStyle.select.value,
      rwxEnabled: rwxEnabled.input.checked,
      forge: forgeSel.select.value,
      forgeChoices: s.forgeChoices,
      activeForge: s.activeForge,
      updateStyleChoices: s.updateStyleChoices,
      theme: theme.select.value,
      themeChoices: s.themeChoices,
      appearance: appearance.select.value,
      appearanceChoices: s.appearanceChoices,
      tabCounts: tabCountsSel.select.value,
      tabCountsChoices: s.tabCountsChoices,
      pollBaseSeconds: Number(pollSecs.input.value),
      slackReadyStatuses: [...readySet.values()],
      slackTemplate: slackTemplateField.input.value.trim(),
      activeHours: {
        enabled: hoursEnabled.input.checked,
        days: dayToggles.filter((b) => b.classList.contains('on')).map((b) => Number(b.dataset.day)),
        start: start.input.value.trim(),
        end: end.input.value.trim(),
      },
      repos: repoFields.map((f) => ({
        projectPath: f.projectPath,
        checkout: f.checkout.input.value.trim(),
        rwxDefinition: f.rwxDefinition,
        testGate: f.gate.select.value,
      })),
      repoGateChoices: s.repoGateChoices,
    };
    save.disabled = true;
    msg.set('Saving…');
    void window.radar.saveSettings(next).then((res) => {
      // Deliberately no auto-close: keep the panel open for further edits;
      // Done (or Escape) closes it when the user decides they're finished.
      msg.set(res.message, res.ok ? 'ok' : 'err');
      save.disabled = false;
    });
  });

  // Settings are tabbed by category to keep the panel scannable. Every field
  // stays mounted (just hidden), so Save always reads the full form.
  const paneOf = (children: HTMLElement[]): HTMLElement => {
    const pane = el('div', 'settings-pane');
    pane.append(...children);
    return pane;
  };
  const settingsPanes: Record<string, HTMLElement> = {
    General: paneOf([updateStyle.wrap, login.wrap]),
    Git: paneOf([forgeSel.wrap, rwxEnabled.wrap, ...repoFields.map((f) => f.row)]),
    Jira: paneOf([atlassianUrl.wrap, email.wrap, ownerWrap, statusBlock, routingRules.block, noMrBlock]),
    Polling: paneOf([pollSecs.wrap, recent.wrap, hoursEnabled.wrap, hoursBlock]),
    Slack: paneOf([slackBlock]),
    Notifications: paneOf([notify.wrap, sound.wrap, method.wrap]),
    Display: paneOf([theme.wrap, appearance.wrap, tabCountsSel.wrap]),
  };
  const paneNames = Object.keys(settingsPanes);
  // Reopening settings lands on the tab you were using last (per machine).
  const stored = localStorage.getItem('settings-tab');
  const initialPane = stored && paneNames.includes(stored) ? stored : 'General';
  const showPane = (name: string): void => {
    for (const [paneName, pane] of Object.entries(settingsPanes)) pane.hidden = paneName !== name;
    localStorage.setItem('settings-tab', name);
  };
  const settingsTabs = createTabBar({
    tabs: paneNames.map((name) => ({ key: name, label: name })),
    active: initialPane,
    onSelect: showPane,
    ariaLabel: 'Settings categories',
    extraClass: 'settings-tabs',
  });
  showPane(initialPane);

  form.append(...Object.values(settingsPanes));
  // Title + tabs stay pinned while the panes scroll underneath.
  const sticky = el('div', 'settings-sticky');
  sticky.append(head, settingsTabs.root);
  // ...and the action affordances pin to the bottom edge, mirroring it.
  const footer = el('div', 'settings-footer');
  const saveRow = el('div', 'settings-save-row');
  saveRow.append(save, msg.root);
  footer.append(saveRow, shareRow);
  settingsEl.replaceChildren(sticky, form, footer);
}

const shortProject = (path: string): string => path.split('/').pop() ?? path;

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const timeAgo = (iso: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};

// Kick off last, once every `const` above (render, helpers) is initialized.
window.radar.onSnapshot(render);
void window.radar.getSnapshot().then(render);
