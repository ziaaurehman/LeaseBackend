const { prisma } = require('../config/db');
const { redis } = require('../config/redis');
const cloudinary = require('../config/cloudinary');

const TENANT_TTL = 600;  // 10 min
const DOCS_TTL   = 600;
const COUNT_TTL  = 300;  // 5 min

// ─── Expiry status helper ─────────────────────────────────────────────────────

const getExpiryStatus = (expiryDate) => {
  if (!expiryDate) return 'NA';
  const now      = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (expiryDate < now)      return 'EXPIRED';
  if (expiryDate < in30Days) return 'EXPIRING_SOON';
  return 'VALID';
};

const withExpiryStatus = (doc) => ({ ...doc, expiryStatus: getExpiryStatus(doc.expiryDate) });

// ─── displayName builder ──────────────────────────────────────────────────────

const buildDisplayName = (data) => {
  if (data.type === 'COMPANY') return data.companyName || '';
  return [data.firstName, data.lastName].filter(Boolean).join(' ');
};

// ─── Cache helpers ────────────────────────────────────────────────────────────

const cacheTenant    = (id, data) => redis.setEx(`tenant:${id}`, TENANT_TTL, JSON.stringify(data));
const cacheDocs      = (id, data) => redis.setEx(`tenant:${id}:docs`, DOCS_TTL, JSON.stringify(data));

const invalidateTenant = async (id) => {
  await Promise.all([
    redis.del(`tenant:${id}`),
    redis.del(`tenant:${id}:docs`),
    redis.del('tenant:count'),
  ]);
};

// ─── Cloudinary helpers ───────────────────────────────────────────────────────

const uploadDocToCloudinary = (buffer, tenantId, originalName) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `lms/tenants/${tenantId}/documents`,
        resource_type: 'auto',  // supports PDF + images
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({ fileUrl: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });

// ═══════════════════════════════════════════════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════════════════════════════════════════════

const createTenant = async (data, actorId) => {
  // email uniqueness check
  if (data.email) {
    const exists = await prisma.tenant.findFirst({
      where: { email: data.email, isDeleted: false },
    });
    if (exists) throw { status: 409, message: 'A tenant with this email already exists' };
  }

  const displayName = buildDisplayName(data);

  const tenant = await prisma.tenant.create({
    data: { ...data, displayName, createdBy: actorId },
  });

  // warm cache + increment count
  await cacheTenant(tenant.id, tenant);
  await redis.del('tenant:count');

  return tenant;
};

const listTenants = async ({ page, limit, type, nationality, isDeleted, hasExpiredDocs, search }) => {
  const where = { isDeleted: isDeleted !== undefined ? isDeleted : false };

  if (type)        where.type        = type;
  if (nationality) where.nationality = { contains: nationality, mode: 'insensitive' };

  // 3-field indexed search (displayName, email, phone)
  if (search) {
    where.OR = [
      { displayName: { contains: search, mode: 'insensitive' } },
      { email:       { contains: search, mode: 'insensitive' } },
      { phone:       { contains: search, mode: 'insensitive' } },
      { nationalIdNumber: { contains: search, mode: 'insensitive' } },
      { passportNumber:   { contains: search, mode: 'insensitive' } },
    ];
  }

  // subquery filter: tenants with at least one expired document
  if (hasExpiredDocs) {
    where.documents = {
      some: { expiryDate: { lt: new Date() }, isDeleted: false },
    };
  }

  const [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, type: true, displayName: true,
        firstName: true, lastName: true, companyName: true,
        email: true, phone: true, nationality: true,
        isDeleted: true, createdAt: true,
        _count: { select: { documents: { where: { isDeleted: false } } } },
      },
    }),
    prisma.tenant.count({ where }),
  ]);

  return { tenants, total, page, totalPages: Math.ceil(total / limit) };
};

const getTenantById = async (id) => {
  const cached = await redis.get(`tenant:${id}`);
  if (cached) return JSON.parse(cached);

  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: {
      documents: {
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!tenant) throw { status: 404, message: 'Tenant not found' };

  // attach expiry status to each document
  const result = {
    ...tenant,
    documents: tenant.documents.map(withExpiryStatus),
  };

  await cacheTenant(id, result);
  return result;
};

const updateTenant = async (id, data) => {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant || tenant.isDeleted) throw { status: 404, message: 'Tenant not found' };

  // type cannot be changed
  if (data.type && data.type !== tenant.type) {
    throw { status: 400, message: 'Tenant type cannot be changed after creation' };
  }

  // email uniqueness
  if (data.email && data.email !== tenant.email) {
    const taken = await prisma.tenant.findFirst({
      where: { email: data.email, isDeleted: false, id: { not: id } },
    });
    if (taken) throw { status: 409, message: 'Email is already in use by another tenant' };
  }

  // rebuild displayName if name fields changed
  const merged = { ...tenant, ...data };
  const displayName = buildDisplayName(merged);

  const updated = await prisma.tenant.update({
    where: { id },
    data: { ...data, displayName },
  });

  await invalidateTenant(id);
  await cacheTenant(id, updated);
  return updated;
};

const softDeleteTenant = async (id, actorId) => {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw { status: 404, message: 'Tenant not found' };
  if (tenant.isDeleted) throw { status: 409, message: 'Tenant is already deleted' };

  // TODO Module 5: block if tenant has an active lease

  const now = new Date();

  // cascade soft delete all active documents
  await prisma.$transaction([
    prisma.tenantDocument.updateMany({
      where: { tenantId: id, isDeleted: false },
      data:  { isDeleted: true, deletedAt: now, deletedBy: actorId },
    }),
    prisma.tenant.update({
      where: { id },
      data:  { isDeleted: true, deletedAt: now, deletedBy: actorId },
    }),
  ]);

  await invalidateTenant(id);
};

const recoverTenant = async (id) => {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw { status: 404, message: 'Tenant not found' };
  if (!tenant.isDeleted) throw { status: 409, message: 'Tenant is not deleted' };

  // check email uniqueness on recovery (another tenant may have taken it)
  if (tenant.email) {
    const taken = await prisma.tenant.findFirst({
      where: { email: tenant.email, isDeleted: false },
    });
    if (taken) throw { status: 409, message: 'Email is now in use by another tenant. Update the email before recovering.' };
  }

  const updated = await prisma.tenant.update({
    where: { id },
    data:  { isDeleted: false, deletedAt: null, deletedBy: null },
    // documents stay soft-deleted — recovered individually
  });

  await invalidateTenant(id);
  await cacheTenant(id, updated);
};

const hardDeleteTenant = async (id) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: { documents: { select: { publicId: true } } },
  });
  if (!tenant) throw { status: 404, message: 'Tenant not found' };
  if (!tenant.isDeleted) {
    throw { status: 409, message: 'Tenant must be soft-deleted before permanent deletion' };
  }

  // TODO Module 5: block if tenant has any lease records

  // delete all Cloudinary files in parallel
  if (tenant.documents.length > 0) {
    await Promise.all(
      tenant.documents
        .filter((d) => d.publicId)
        .map((d) => cloudinary.uploader.destroy(d.publicId, { resource_type: 'auto' }).catch(() => {}))
    );
  }

  // cascade delete documents then tenant
  await prisma.$transaction([
    prisma.tenantDocument.deleteMany({ where: { tenantId: id } }),
    prisma.tenant.delete({ where: { id } }),
  ]);

  await invalidateTenant(id);
};

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════════

const uploadDocuments = async (tenantId, files, { type, expiryDate, notes }, actorId) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.isDeleted) throw { status: 404, message: 'Tenant not found' };

  // check active document limit
  const activeCount = await prisma.tenantDocument.count({
    where: { tenantId, isDeleted: false },
  });
  const MAX_DOCS = 20;
  if (activeCount + files.length > MAX_DOCS) {
    throw {
      status: 400,
      message: `Maximum ${MAX_DOCS} documents per tenant. Currently has ${activeCount}.`,
    };
  }

  // upload all files to Cloudinary in parallel
  const uploadResults = await Promise.all(
    files.map((f) => uploadDocToCloudinary(f.buffer, tenantId, f.originalname))
  );

  // bulk insert all document records
  const docData = uploadResults.map((result, i) => ({
    tenantId,
    type,
    fileUrl:    result.fileUrl,
    publicId:   result.publicId,
    fileName:   files[i].originalname,
    fileSize:   files[i].size,
    mimeType:   files[i].mimetype,
    expiryDate: expiryDate || null,
    notes:      notes || null,
    uploadedBy: actorId,
  }));

  await prisma.tenantDocument.createMany({ data: docData });

  // fetch freshly created docs to return
  const created = await prisma.tenantDocument.findMany({
    where: { tenantId, uploadedBy: actorId, type, isDeleted: false },
    orderBy: { createdAt: 'desc' },
    take: files.length,
  });

  await redis.del(`tenant:${tenantId}:docs`);
  await invalidateTenant(tenantId);

  return created.map(withExpiryStatus);
};

const listDocuments = async (tenantId, { type, isDeleted, expiryStatus }) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw { status: 404, message: 'Tenant not found' };

  // use cache only for default query (no filters)
  const isDefaultQuery = !type && isDeleted === undefined && !expiryStatus;
  if (isDefaultQuery) {
    const cached = await redis.get(`tenant:${tenantId}:docs`);
    if (cached) return JSON.parse(cached);
  }

  const where = {
    tenantId,
    isDeleted: isDeleted !== undefined ? isDeleted : false,
  };
  if (type) where.type = type;

  const docs = await prisma.tenantDocument.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  let result = docs.map(withExpiryStatus);

  // filter by expiryStatus in JS (computed field, zero extra queries)
  if (expiryStatus) {
    result = result.filter((d) => d.expiryStatus === expiryStatus);
  }

  if (isDefaultQuery) await cacheDocs(tenantId, result);
  return result;
};

const getDocumentById = async (tenantId, docId) => {
  const doc = await prisma.tenantDocument.findFirst({
    where: { id: docId, tenantId },
  });
  if (!doc) throw { status: 404, message: 'Document not found' };
  return withExpiryStatus(doc);
};

const updateDocument = async (tenantId, docId, data) => {
  const doc = await prisma.tenantDocument.findFirst({
    where: { id: docId, tenantId, isDeleted: false },
  });
  if (!doc) throw { status: 404, message: 'Document not found' };

  const updated = await prisma.tenantDocument.update({
    where: { id: docId },
    data,
  });

  await redis.del(`tenant:${tenantId}:docs`);
  await redis.del(`tenant:${tenantId}`);

  return withExpiryStatus(updated);
};

const softDeleteDocument = async (tenantId, docId, actorId) => {
  const doc = await prisma.tenantDocument.findFirst({
    where: { id: docId, tenantId },
  });
  if (!doc) throw { status: 404, message: 'Document not found' };
  if (doc.isDeleted) throw { status: 409, message: 'Document is already deleted' };

  await prisma.tenantDocument.update({
    where: { id: docId },
    data:  { isDeleted: true, deletedAt: new Date(), deletedBy: actorId },
  });

  await redis.del(`tenant:${tenantId}:docs`);
  await redis.del(`tenant:${tenantId}`);
};

const recoverDocument = async (tenantId, docId) => {
  const doc = await prisma.tenantDocument.findFirst({
    where: { id: docId, tenantId },
  });
  if (!doc) throw { status: 404, message: 'Document not found' };
  if (!doc.isDeleted) throw { status: 409, message: 'Document is not deleted' };

  // check tenant itself is not deleted
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.isDeleted) {
    throw { status: 400, message: 'Cannot recover a document whose tenant is deleted. Recover the tenant first.' };
  }

  // enforce document limit on recovery
  const activeCount = await prisma.tenantDocument.count({
    where: { tenantId, isDeleted: false },
  });
  if (activeCount >= 20) {
    throw { status: 400, message: 'Cannot recover: tenant already has 20 active documents (maximum).' };
  }

  await prisma.tenantDocument.update({
    where: { id: docId },
    data:  { isDeleted: false, deletedAt: null, deletedBy: null },
  });

  await redis.del(`tenant:${tenantId}:docs`);
  await redis.del(`tenant:${tenantId}`);
};

const hardDeleteDocument = async (tenantId, docId) => {
  const doc = await prisma.tenantDocument.findFirst({
    where: { id: docId, tenantId },
  });
  if (!doc) throw { status: 404, message: 'Document not found' };
  if (!doc.isDeleted) {
    throw { status: 409, message: 'Document must be soft-deleted before permanent deletion' };
  }

  // delete from Cloudinary — non-fatal if already gone
  if (doc.publicId) {
    await cloudinary.uploader
      .destroy(doc.publicId, { resource_type: 'auto' })
      .catch(() => {});
  }

  await prisma.tenantDocument.delete({ where: { id: docId } });

  await redis.del(`tenant:${tenantId}:docs`);
  await redis.del(`tenant:${tenantId}`);
};

// ─── Dashboard count (cached) ─────────────────────────────────────────────────

const getTenantCount = async () => {
  const cached = await redis.get('tenant:count');
  if (cached) return parseInt(cached);

  const count = await prisma.tenant.count({ where: { isDeleted: false } });
  await redis.setEx('tenant:count', COUNT_TTL, String(count));
  return count;
};

module.exports = {
  createTenant,
  listTenants,
  getTenantById,
  updateTenant,
  softDeleteTenant,
  recoverTenant,
  hardDeleteTenant,
  uploadDocuments,
  listDocuments,
  getDocumentById,
  updateDocument,
  softDeleteDocument,
  recoverDocument,
  hardDeleteDocument,
  getTenantCount,
};
