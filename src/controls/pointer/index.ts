/**
 * `controls/pointer` — raw pointer and discrete touch gesture recognition.
 *
 * {@link PointerControls} keeps per-pointer state (which pointers are down, where each
 * started, how far each has moved, capture bookkeeping) and is the base for a custom
 * gizmo or marquee. {@link TouchControls} layers discrete gesture recognition
 * (tap/double-tap/long-press/swipe) on top of the same event plumbing.
 *
 * @packageDocumentation
 */

export * from './PointerControls';
export * from './TouchControls';
