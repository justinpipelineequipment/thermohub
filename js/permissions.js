// Role-based access. The backend will enforce the same rules server-side.
window.Perm = (function () {
  const ROLES = {
    platform_admin: 'Platform Admin',
    business_admin: 'Business Admin',
    building_manager: 'Building Manager',
    viewer: 'Viewer',
  };

  function isPlatform(u) { return u.role === 'platform_admin'; }

  function inBusiness(u, businessId) {
    return isPlatform(u) || u.businessId === businessId;
  }

  // Empty buildingIds means "all buildings in the business".
  function hasBuilding(u, b) {
    if (isPlatform(u)) return true;
    if (u.businessId !== b.businessId) return false;
    if (u.role === 'business_admin') return true;
    return u.buildingIds.length === 0 || u.buildingIds.includes(b.id);
  }

  function isBusinessAdmin(u, businessId) {
    return isPlatform(u) || (u.role === 'business_admin' && u.businessId === businessId);
  }

  return {
    ROLES,
    isPlatform,
    isBusinessAdmin,
    canViewBusiness: inBusiness,
    canViewBuilding: hasBuilding,
    canControl(u, b) {
      return hasBuilding(u, b) && u.role !== 'viewer';
    },
    // Assign a schedule profile to thermostats in this building.
    canAssignSchedule(u, b) {
      return hasBuilding(u, b) && u.role !== 'viewer';
    },
    canCreateSchedule(u, businessId) {
      return isPlatform(u) || (u.role === 'business_admin' && u.businessId === businessId);
    },
    // Admins edit any profile in their business. Building Managers may edit a profile
    // only if every thermostat using it is in one of their buildings.
    canEditSchedule(u, sched, usedInBuildings) {
      if (isPlatform(u)) return true;
      if (u.businessId !== sched.businessId) return false;
      if (u.role === 'business_admin') return true;
      if (u.role !== 'building_manager' || !usedInBuildings.length) return false;
      return usedInBuildings.every(b => hasBuilding(u, b));
    },
    canManageUsers(u, businessId) {
      return isPlatform(u) || (u.role === 'business_admin' && u.businessId === businessId);
    },
    canViewHubs(u, businessId) {
      return isPlatform(u) || (u.role === 'business_admin' && u.businessId === businessId);
    },
    // Roles a user may grant to others.
    assignableRoles(u) {
      if (isPlatform(u)) return ['business_admin', 'building_manager', 'viewer'];
      if (u.role === 'business_admin') return ['business_admin', 'building_manager', 'viewer'];
      return [];
    },
  };
})();
