import { stripVTControlCharacters } from "node:util";

export const cleanText = (text: string): string => stripVTControlCharacters(text).replaceAll("\t", " ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
