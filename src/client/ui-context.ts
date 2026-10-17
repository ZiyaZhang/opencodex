/**
 * Where the page components get the DSH controls. Only the type of the set comes from ui.ts, so loading a component never loads the
 * primitives package: tests render the page in Node, where that package cannot load.
 */
import { createContext, useContext } from 'react';
import type { Ui } from './ui.js';

export const UiContext = createContext<Ui | null>(null);

/** The DSH controls of the page this component is in. */
export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('OpenCodex: the page was rendered without its DSH controls');
  return ui;
}
