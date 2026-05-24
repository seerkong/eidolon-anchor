import { effect, stop } from "@vue/reactivity";
import { useEffect, useState } from "react";

export const useReactiveValue = <T>(getter: () => T): T => {
  const [value, setValue] = useState<T>(() => getter());

  useEffect(() => {
    const runner = effect(() => {
      setValue(getter());
    });
    return () => stop(runner);
  }, [getter]);

  return value;
};
