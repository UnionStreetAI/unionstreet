import { useEffect, useState } from "react";
import { listProfiles, resolveDelegationTargets } from "@unionstreet/us-core";

export function useDelegationTargets(profileName: string): {
  allProfiles: string[];
  visibleProfiles: string[];
  addProfile(name: string): void;
} {
  const [allProfiles, setAllProfiles] = useState<string[]>([]);
  const [visibleProfiles, setVisibleProfiles] = useState<string[]>([]);

  useEffect(() => {
    listProfiles().then(setAllProfiles).catch(() => setAllProfiles([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveDelegationTargets(profileName)
      .then((targets) => {
        if (!cancelled) setVisibleProfiles(targets.map((target) => target.profile));
      })
      .catch(() => {
        if (!cancelled) setVisibleProfiles(allProfiles.filter((name) => name !== profileName));
      });
    return () => {
      cancelled = true;
    };
  }, [profileName, allProfiles]);

  return {
    allProfiles,
    visibleProfiles,
    addProfile(name: string) {
      setAllProfiles((prev) => (prev.includes(name) ? prev : [...prev, name].sort()));
    },
  };
}
