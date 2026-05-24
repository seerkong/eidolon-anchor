export type SkillEntry = {
  name: string;
  description: string;
  body: string;
  dir: string;
  resources?: string[];
};

export type SkillEntryLoader = (skillsDir: string) => Record<string, SkillEntry>;
