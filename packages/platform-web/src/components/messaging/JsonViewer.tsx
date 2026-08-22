import React from "react";
import { CodeBlock } from "./CodeBlock.tsx";

export interface JsonViewerProps {
  data: unknown;
  title?: string;
}

export function JsonViewer({ data, title = "JSON message body" }: JsonViewerProps) {
  const jsonString = React.useMemo(() => {
    try {
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  return <CodeBlock code={jsonString} language="json" title={title} />;
}
