// Role-based access, enforced server-side. Mirrors js/permissions.js in the dashboard.
export const ROLES = {
  platform_admin: 'Platform Admin',
  business_admin: 'Business Admin',
  building_manager: 'Building Manager',
  viewer: 'Viewer',
};

export const isPlatform = u => u.role === 'platform_admin';

export const canViewBusiness = (u, businessId) => isPlatform(u) || u.businessId === businessId;

// Empty buildingIds means "all buildings in the business".
export function canViewBuilding(u, b) {
  if (isPlatform(u)) return true;
  if (u.businessId !== b.businessId) return false;
  if (u.role === 'business_admin') return true;
  return u.buildingIds.length === 0 || u.buildingIds.includes(b.id);
}

export const canControl = (u, b) => canViewBuilding(u, b) && u.role !== 'viewer';
export const canAssignSchedule = canControl;

export const isBusinessAdmin = (u, businessId) =>
  isPlatform(u) || (u.role === 'business_admin' && u.businessId === businessId);

export const canCreateSchedule = isBusinessAdmin;
export const canManageUsers = isBusinessAdmin;
export const canManageBuildings = isBusinessAdmin;

export function canEditSchedule(u, sched, usedInBuildings) {
  if (isPlatform(u)) return true;
  if (u.businessId !== sched.businessId) return false;
  if (u.role === 'business_admin') return true;
  if (u.role !== 'building_manager' || !usedInBuildings.length) return false;
  return usedInBuildings.every(b => canViewBuilding(u, b));
}

export const ASSIGNABLE_ROLES = ['business_admin', 'building_manager', 'viewer'];
