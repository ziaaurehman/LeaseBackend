const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const AppError = require('../utils/AppError');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_SIZE_MB = 10;

// store file in memory before uploading to Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    return cb(new AppError('Only JPEG, PNG, WEBP, and PDF files are allowed', 400), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
});

// upload buffer to Cloudinary and return result
const uploadToCloudinary = (buffer, folder, options = {}) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `lease-management/${folder}`, ...options },
      (error, result) => {
        if (error) return reject(new AppError('File upload failed', 500));
        resolve(result);
      }
    );
    stream.end(buffer);
  });
};

// delete a file from Cloudinary by public_id
const deleteFromCloudinary = async (publicId) => {
  await cloudinary.uploader.destroy(publicId);
};

module.exports = { upload, uploadToCloudinary, deleteFromCloudinary };
