import {
  CreateIncidentInput,
  IncidentFeature,
  IncidentFeatureCollection,
  IncidentStatus,
  IncidentType,
  User,
  UserRole,
} from '@safetymap/shared';

export interface CreateUserData {
  email: string;
  passwordHash: string;
  name?: string;
  role: UserRole;
  agencyId?: string;
}

export interface IUserRepository {
  create(data: CreateUserData): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  clear?(): Promise<void>;
}

export interface IncidentFilterOptions {
  bbox?: string; // minLng,minLat,maxLng,maxLat
  type?: IncidentType;
  since?: string;
  limit?: number;
}

export interface IIncidentRepository {
  create(data: CreateIncidentInput & { reportedBy?: string }): Promise<IncidentFeature>;
  findById(id: string): Promise<IncidentFeature | null>;
  findByQuery(options: IncidentFilterOptions): Promise<IncidentFeatureCollection>;
  verify(
    id: string,
    agencyUserId: string,
    notes?: string,
    status?: IncidentStatus,
  ): Promise<IncidentFeature | null>;
  clear?(): Promise<void>;
}
