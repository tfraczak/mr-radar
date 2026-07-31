/**
 * The design system: every reusable UI primitive lives here, so hit areas,
 * ARIA state, tones, and styling can never drift between screens. renderer.ts
 * composes these; it should not hand-roll markup that has a component here.
 *
 * Styling contract: each component owns one CSS block in styles.css, keyed by
 * the class names created here (`.tabs`/`.tab`, `.btn-*`, `.badge`, `.chip`,
 * `.collapsible-*`, …). Tones map to the theme tokens (--good/--bad/--warn/…).
 */

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

let systemSchemeMedia: MediaQueryList | undefined;

/**
 * Apply a theme + appearance: sets data-theme / data-scheme on <html>, which
 * the palette blocks in styles.css key off. Theme is the personality (each
 * defines a light and a dark half); appearance picks the half — 'system'
 * follows the OS live via matchMedia.
 */
export const applyTheme = (theme: string, appearance: string): void => {
  const root = document.documentElement;
  if (theme && theme !== 'system') root.dataset.theme = theme;
  else delete root.dataset.theme;

  systemSchemeMedia ??= window.matchMedia('(prefers-color-scheme: dark)');
  const resolve = (): void => {
    root.dataset.scheme =
      appearance === 'light' || appearance === 'dark'
        ? appearance
        : systemSchemeMedia?.matches
          ? 'dark'
          : 'light';
  };
  systemSchemeMedia.onchange = appearance === 'system' ? resolve : null;
  resolve();
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** THE tab bar. Main view and settings categories are both instances of it. */
export const createTabBar = <T extends string>(opts: {
  tabs: { key: T; label: string }[];
  active: T;
  onSelect: (key: T) => void;
  ariaLabel?: string;
  extraClass?: string;
}): {
  root: HTMLElement;
  setActive: (key: T) => void;
  setLabel: (key: T, label: string) => void;
} => {
  const root = el('nav', opts.extraClass ? `tabs ${opts.extraClass}` : 'tabs');
  if (opts.ariaLabel) root.setAttribute('aria-label', opts.ariaLabel);
  const buttons = new Map<T, HTMLButtonElement>();
  let active = opts.active;
  const paint = (): void => {
    for (const [key, btn] of buttons) btn.setAttribute('aria-selected', String(key === active));
  };
  for (const t of opts.tabs) {
    const btn = el('button', 'tab', t.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      active = t.key;
      paint();
      opts.onSelect(t.key);
    });
    buttons.set(t.key, btn);
    root.append(btn);
  }
  paint();
  return {
    root,
    setActive: (key) => {
      active = key;
      paint();
    },
    setLabel: (key, label) => {
      const btn = buttons.get(key);
      if (btn) btn.textContent = label;
    },
  };
};

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'default' | 'primary' | 'action' | 'link' | 'destructive';

/**
 * Button variants: `primary` = the one main affirmative action on a screen
 * (Save); `action` = a compact row-level verb (Start run, Become reviewer);
 * `link` = borderless inline action (Mark all read); `destructive` = removes
 * something (red); `default` = everything else. All render <button type=button>.
 */
export const createButton = (
  label: string,
  opts: { variant?: ButtonVariant; title?: string; onClick?: (e: MouseEvent) => void } = {},
): HTMLButtonElement => {
  const variant = opts.variant ?? 'default';
  const className =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'action'
        ? 'start-run'
        : variant === 'link'
          ? 'link'
          : variant === 'destructive'
            ? 'btn-destructive'
            : undefined;
  const btn = el('button', className, label);
  btn.type = 'button';
  if (opts.title) btn.title = opts.title;
  if (opts.onClick) btn.addEventListener('click', opts.onClick);
  return btn;
};

// ---------------------------------------------------------------------------
// Chips and badges
// ---------------------------------------------------------------------------

export type Tone = 'good' | 'bad' | 'busy' | 'warn' | 'info' | 'accent' | 'muted' | 'none';

/** The prominent status pill (the CI chip). Tone drives color. */
export const createChip = (text: string, tone: Tone, title?: string): HTMLElement => {
  const chip = el('span', `chip chip-${tone}`, text);
  if (title) chip.title = title;
  return chip;
};

/** A small inline annotation on a row ("your review", "draft", "frontend ✓"). */
export const createBadge = (text: string, tone: Tone, title?: string): HTMLElement => {
  const badge = el('span', `badge badge-${tone}`, text);
  if (title) badge.title = title;
  return badge;
};

/** A chip with a remove ×, for editable collections (status sections). */
export const createRemovableChip = (
  text: string,
  opts: { removeTitle?: string; onRemove: (e: MouseEvent) => void },
): HTMLElement => {
  const chip = el('span', 'msf-chip', text);
  const x = el('span', 'msf-chip-x', '×');
  if (opts.removeTitle) x.title = opts.removeTitle;
  x.addEventListener('click', opts.onRemove);
  chip.append(x);
  return chip;
};

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

/**
 * A titled block that folds. Collapse state persists under `storageKey` once
 * the user toggles it; `refresh()` re-renders the header label (for counts).
 */
export const createCollapsible = (opts: {
  label: () => string;
  storageKey?: string;
  defaultCollapsed: boolean;
}): { root: HTMLElement; body: HTMLElement; refresh: () => void } => {
  const root = el('section', 'other-section');
  const header = el('button', 'other-header');
  header.type = 'button';
  const body = el('div', 'other-body');
  const stored = opts.storageKey ? localStorage.getItem(opts.storageKey) : null;
  let collapsed = stored === null ? opts.defaultCollapsed : stored === 'true';

  const refresh = (): void => {
    header.textContent = `${collapsed ? '▸' : '▾'}  ${opts.label()}`;
    body.hidden = collapsed;
  };
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    if (opts.storageKey) localStorage.setItem(opts.storageKey, String(collapsed));
    refresh();
  });
  refresh();
  root.append(header, body);
  return { root, body, refresh };
};

// ---------------------------------------------------------------------------
// Dropdown panels
// ---------------------------------------------------------------------------

const openPanels = new Set<HTMLElement>();
let outsideCloseInstalled = false;

/**
 * Wire a trigger + panel into the shared dropdown behavior: trigger toggles,
 * opening one closes the others, clicking outside closes all, clicks inside
 * stay inside. Call sites style the panel; this owns only the choreography.
 */
export const registerDropdown = (
  trigger: HTMLElement,
  panel: HTMLElement,
  onOpen?: () => void,
): { close: () => void } => {
  if (!outsideCloseInstalled) {
    outsideCloseInstalled = true;
    document.addEventListener('click', () => {
      for (const p of openPanels) p.hidden = true;
      openPanels.clear();
    });
  }
  panel.hidden = true;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = panel.hidden;
    for (const p of openPanels) p.hidden = true;
    openPanels.clear();
    if (opening) {
      onOpen?.();
      panel.hidden = false;
      openPanels.add(panel);
    }
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  return {
    close: () => {
      panel.hidden = true;
      openPanels.delete(panel);
    },
  };
};

// ---------------------------------------------------------------------------
// Themed select
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  /** Display text; defaults to the value. */
  label?: string;
  /** Hover tooltip on the option row. */
  title?: string;
}

/**
 * A select whose popup is our own themed panel. The OS-native popup ignores
 * page CSS entirely, so it can never match the theme — this replaces it. The
 * real <select> stays in the DOM (hidden) as the state holder, so callers keep
 * reading/assigning `.value`, setting `.title`, and listening for 'change'.
 */
export const createSelect = (
  options: (string | SelectOption)[],
  value: string,
): { root: HTMLElement; select: HTMLSelectElement; setOptions: (options: (string | SelectOption)[]) => void } => {
  let opts: SelectOption[] = options.map((o) => (typeof o === 'string' ? { value: o } : o));
  if (value && !opts.some((o) => o.value === value)) opts.unshift({ value });
  const labelOf = (v: string): string => {
    const o = opts.find((x) => x.value === v);
    return o?.label ?? o?.value ?? v;
  };

  const root = el('span', 'select-wrap');
  const select = el('select', 'field-input');
  select.hidden = true;
  const paintNative = (): void => {
    const current = select.value;
    select.replaceChildren();
    for (const o of opts) {
      const opt = el('option', undefined, o.label ?? o.value);
      opt.value = o.value;
      if (o.value === current || (!current && o.value === value)) opt.selected = true;
      select.append(opt);
    }
  };
  for (const o of opts) {
    const opt = el('option', undefined, o.label ?? o.value);
    opt.value = o.value;
    if (o.value === value) opt.selected = true;
    select.append(opt);
  }

  const trigger = el('button', 'field-input select-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  const triggerLabel = el('span', 'select-trigger-label', labelOf(select.value));
  trigger.append(triggerLabel, el('span', 'select-chevron', '▾'));
  // Callers set tooltips on `.select` after creation; mirror them lazily.
  trigger.addEventListener('mouseenter', () => {
    if (select.title) trigger.title = select.title;
  });

  const panel = el('div', 'select-panel');
  panel.setAttribute('role', 'listbox');
  const paint = (): void => {
    panel.replaceChildren();
    for (const o of opts) {
      const selected = o.value === select.value;
      const row = el('div', 'select-option');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      if (o.title) row.title = o.title;
      row.append(el('span', 'select-check', selected ? '✓' : ''), el('span', undefined, o.label ?? o.value));
      row.addEventListener('click', () => {
        select.value = o.value;
        triggerLabel.textContent = labelOf(o.value);
        select.dispatchEvent(new Event('change'));
        dd.close();
      });
      panel.append(row);
    }
  };
  const dd = registerDropdown(trigger, panel, paint);
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dd.close();
  });
  // External `.value` writes (rare) repaint on next open; keep trigger synced.
  select.addEventListener('change', () => {
    triggerLabel.textContent = labelOf(select.value);
  });
  root.append(select, trigger, panel);
  /**
   * Swap the choice list. The current value is kept when still offered;
   * otherwise the first option wins and a 'change' event fires so callers
   * and the trigger label stay in sync.
   */
  const setOptions = (next: (string | SelectOption)[]): void => {
    const keep = select.value;
    opts = next.map((o) => (typeof o === 'string' ? { value: o } : o));
    paintNative();
    if (opts.some((o) => o.value === keep)) select.value = keep;
    else {
      select.value = opts[0]?.value ?? '';
      select.dispatchEvent(new Event('change'));
    }
    triggerLabel.textContent = labelOf(select.value);
  };
  return { root, select, setOptions };
};

// ---------------------------------------------------------------------------
// Inline status message
// ---------------------------------------------------------------------------

/**
 * The ok/err feedback line under forms (Save results, connect results).
 * Success confirmations linger ~5s and then fade out; errors and neutral
 * progress text stay until replaced.
 */
export const createStatusMessage = (
  baseClass = 'settings-msg',
): { root: HTMLElement; set: (text: string, kind?: 'ok' | 'err') => void } => {
  const root = el('div', baseClass);
  let fadeTimer: number | undefined;
  let clearTimer: number | undefined;
  return {
    root,
    set: (text, kind) => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
      root.textContent = text;
      root.className = kind ? `${baseClass} ${kind}` : baseClass;
      if (kind === 'ok') {
        fadeTimer = window.setTimeout(() => {
          root.classList.add('msg-fade');
          clearTimer = window.setTimeout(() => {
            root.textContent = '';
            root.className = baseClass;
          }, 700);
        }, 5000);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Row (the MR tile)
// ---------------------------------------------------------------------------

/**
 * The list row skeleton: unread dot | main column (title, attention, meta
 * badge strip) | side column (chips + actions). Callers fill the slots; the
 * grid and click behavior live here so every list renders the same tile.
 */
export const createRow = (opts: {
  unread: boolean;
  onClick: () => void;
}): { root: HTMLElement; main: HTMLElement; meta: HTMLElement; side: HTMLElement } => {
  const root = el('div', opts.unread ? 'row unread' : 'row');
  root.append(el('span', 'unread-dot'));
  const main = el('div', 'row-main');
  const meta = el('div', 'row-meta');
  const side = el('div', 'row-side');
  root.append(main, side);
  root.addEventListener('click', opts.onClick);
  return { root, main, meta, side };
};

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
}

export const textField = (label: string, value: string, placeholder = ''): Field => {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field-label', label));
  const input = el('input', 'field-input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  wrap.append(input);
  return { wrap, input };
};

export const numberField = (label: string, value: number): Field => {
  const f = textField(label, String(value));
  f.input.type = 'number';
  f.input.min = '0';
  return f;
};

export const checkboxField = (label: string, checked: boolean): Field => {
  const wrap = el('label', 'field field-check');
  const input = el('input', 'field-checkbox');
  input.type = 'checkbox';
  input.checked = checked;
  wrap.append(input, el('span', 'field-label', label));
  return { wrap, input };
};

export const selectField = (
  label: string,
  options: string[],
  value: string,
): { wrap: HTMLElement; select: HTMLSelectElement } => {
  // A div, not a <label>: label-click forwarding would fight the trigger.
  const wrap = el('div', 'field');
  wrap.append(el('span', 'field-label', label));
  const s = createSelect(options, value);
  wrap.append(s.root);
  return { wrap, select: s.select };
};
