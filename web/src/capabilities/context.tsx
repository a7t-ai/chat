import { createContext, useContext } from "react";

// Lets an inline capability Chip (rendered deep inside streamed markdown) raise its
// payload up to the canvas drawer without prop-threading through the markdown renderer.
// ChatView provides `open`; the Chip calls it on click.
export type OpenCapability = (id: string, payload: string) => void;

const CapabilityContext = createContext<OpenCapability>(() => {});

export const CapabilityProvider = CapabilityContext.Provider;

export function useOpenCapability(): OpenCapability {
  return useContext(CapabilityContext);
}
