/**
 * Small typed DOM helpers for building the playground's control panel.
 *
 * No dependencies and no framework: every builder returns the element it created, plus
 * a handle for reading and writing the current value so a demo's parameters can be
 * reset to their defaults.
 */

/** Handle for one editable parameter. */
export interface ControlHandle<T> {
  /** Root element of the control, already appended to its parent. */
  readonly element: HTMLElement;
  /** Current value. */
  readonly get: () => T;
  /** Overwrites the value and refreshes the control's presentation. */
  readonly set: (value: T) => void;
}

/** Options shared by every control builder. */
export interface ControlOptions<T> {
  /** Visible label. */
  label: string;
  /** Initial value. */
  value: T;
  /** Called after every user edit. */
  onChange?: (value: T) => void;
}

/** Wraps `children` in a labelled `.field` row. */
function labelled(label: string, control: HTMLElement, id: string): HTMLElement {
  const field = document.createElement('div');
  field.className = 'field';

  const text = document.createElement('label');
  text.textContent = label;
  text.htmlFor = id;

  field.append(text, control);
  return field;
}

/** Monotonic counter so every generated control gets a unique id. */
let controlIds = 0;

/**
 * Builds a range slider.
 *
 * The numeric readout is updated on every `input` event, which is also when `onChange`
 * fires, so demos react continuously while dragging.
 */
export function slider(
  parent: HTMLElement,
  options: ControlOptions<number> & { min: number; max: number; step?: number },
): ControlHandle<number> {
  const id = `ctl-${controlIds++}`;
  const row = document.createElement('div');
  row.className = 'slider-row';

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step ?? 0.01);
  input.value = String(options.value);

  const readout = document.createElement('output');
  readout.textContent = formatNumber(options.value);

  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = formatNumber(value);
    options.onChange?.(value);
  });

  row.append(input, readout);
  parent.append(labelled(options.label, row, id));

  return {
    element: row,
    get: () => Number(input.value),
    set: (value: number) => {
      input.value = String(value);
      readout.textContent = formatNumber(value);
    },
  };
}

/** Builds a `<select>` from a list of choices. */
export function select<T extends string>(
  parent: HTMLElement,
  options: ControlOptions<T> & { choices: readonly { value: T; label: string; disabled?: boolean }[] },
): ControlHandle<T> {
  const id = `ctl-${controlIds++}`;
  const element = document.createElement('select');
  element.id = id;

  for (const choice of options.choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    option.disabled = choice.disabled ?? false;
    element.append(option);
  }
  element.value = options.value;

  element.addEventListener('change', () => {
    options.onChange?.(element.value as T);
  });

  parent.append(labelled(options.label, element, id));

  return {
    element,
    get: () => element.value as T,
    set: (value: T) => {
      element.value = value;
    },
  };
}

/** Builds a checkbox presented as a switch row. */
export function toggle(
  parent: HTMLElement,
  options: ControlOptions<boolean>,
): ControlHandle<boolean> {
  const id = `ctl-${controlIds++}`;
  const element = document.createElement('input');
  element.type = 'checkbox';
  element.id = id;
  element.className = 'toggle';
  element.checked = options.value;

  element.addEventListener('change', () => {
    options.onChange?.(element.checked);
  });

  parent.append(labelled(options.label, element, id));

  return {
    element,
    get: () => element.checked,
    set: (value: boolean) => {
      element.checked = value;
    },
  };
}

/** Builds a button that invokes `onClick`. */
export function button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  parent.append(element);
  return element;
}

/** Empties an element without using `innerHTML`. */
export function clear(element: HTMLElement): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild);
}

/** Sets text content, tolerating a missing element. */
export function setText(element: HTMLElement | null, text: string): void {
  if (element !== null) element.textContent = text;
}

/** Shows or hides an element. */
export function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (element !== null) element.hidden = hidden;
}

/** Formats a number for a readout: integers bare, decimals to two places. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
