import { useContext } from "preact/hooks";
import { createContext } from "../../context";

export type GroupOrientation = "horizontal" | "vertical";
export const GroupContext = createContext<GroupOrientation | null>(null);
export const useGroupOrientation = () => useContext(GroupContext);
