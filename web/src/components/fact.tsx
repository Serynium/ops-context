import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { styles } from "../styles";

export const Fact = ({ label, value }: { label: string; value: ReactNode }) => (
  <div {...stylex.props(styles.fact)}>
    <span {...stylex.props(styles.factKey)}>{label}</span>
    <span>{value}</span>
  </div>
);
