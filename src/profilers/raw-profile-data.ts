import { Profile } from 'pprof-format';

export interface RawProfileData {
  profile: Profile;
  profileType: 'wall' | 'heap';
  startedAt: Date;
  stoppedAt: Date;
}
