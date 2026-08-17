import React from "react";

export interface PageContainerProps {
  children: React.ReactNode;
  maxWidth?: number | string;
  style?: React.CSSProperties;
}

export function PageContainer({
  children,
  maxWidth = 1400,
  style,
}: PageContainerProps) {
  return (
    <div
      style={{
        maxWidth,
        margin: "0 auto",
        padding: "24px",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
