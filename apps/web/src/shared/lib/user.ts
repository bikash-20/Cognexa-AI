import { useEffect, useState } from 'react';

const KEY = 'infamous.user_name.v1';

export function getUserName(): string | null {
  return localStorage.getItem(KEY);
}

export function setUserName(name: string): void {
  localStorage.setItem(KEY, name);
}

export function clearUserName(): void {
  localStorage.removeItem(KEY);
}

export function useUserName(): { name: string | null; set: (n: string) => void } {
  const [name, setName] = useState<string | null>(() => getUserName());
  useEffect(() => { setName(getUserName()); }, []);
  return {
    name,
    set: (n: string) => { setUserName(n); setName(n); }
  };
}
