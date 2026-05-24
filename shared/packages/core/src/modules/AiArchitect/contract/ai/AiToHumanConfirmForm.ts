export interface AiToHumanConfirmItem {
  id: string;
  title: string;
  options: { value: string; title: string }[];
  type: 'select' | 'input';
}
