/** 混合练习题型定义（与服务端 content/challenges.ts 对应） */
export type Exercise =
  | { type: "read"; wordIndex: number; word: string; display: string }
  | { type: "mc"; prompt: string; options: string[]; wordIndex: number }
  | { type: "tf"; prompt: string; wordIndex: number; shown: string }
  | { type: "cloze"; sentence: string; options: string[]; wordIndex: number }
  | { type: "build"; sentence: string; blank: string; options: string[]; hint: string }
  | { type: "match"; left: string[]; right: string[]; wordIndices: number[] };
