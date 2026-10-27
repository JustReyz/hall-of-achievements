export interface GalleryFilters {
  q: string;
  from: string;
  to: string;
  tag: string;
}

export interface AchievementItem {
  id: string;
  title: string;
  completionDate: string;
  notes: string | null;
  tags: string[];
  thumbnailPositionX: number;
  thumbnailPositionY: number;
  state: 'pending' | 'ready' | 'deleting';
  createdAt: string;
  updatedAt?: string;
  asset?: {
    id: string;
    width: number;
    height: number;
    originalBytes: number;
    mimeType: string;
    checksum: string;
  } | null;
}

export interface GalleryResponse {
  items: AchievementItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CollectionSummary {
  id: string;
  name: string;
  revision: number;
  memberCount: number;
  updatedAt: string;
}

export interface CollectionMember {
  achievementId: string;
  position: number;
  title: string;
  completionDate: string;
  state: string;
  trashedAt: string | null;
}

export interface CollectionDetail {
  id: string;
  name: string;
  revision: number;
  items: CollectionMember[];
}

export type ObjectHealthState = 'present' | 'missing' | 'unknown';

export interface RestoreRequest {
  achievementId: string;
  linkage: 'present' | 'missing';
  original: ObjectHealthState;
  display: ObjectHealthState;
  thumbnail: ObjectHealthState;
}

export interface StorageQuotaInfo {
  totalAllowanceBytes: number;
  ceilingBytes: number;
  committedBytes: number;
  reservedBytes: number;
  totalAccountedBytes: number;
  remainingCeilingBytes: number;
  activeIntentCount: number;
}
