import { createContext as createPreactContext, type Context as PreactContext } from "preact";
import type { Context as ReactContext } from "react";

export const createContext = <T,>(value: T) =>
  createPreactContext(value) as PreactContext<T> & ReactContext<T>;
