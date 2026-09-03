import { useContext } from "preact/hooks";
import { createContext } from "./context";

export const UiContext = createContext<{ notify: (message: string) => void }>({
  notify: () => undefined,
});
export const useUi = () => useContext(UiContext);
