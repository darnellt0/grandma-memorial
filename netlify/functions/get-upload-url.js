// Netlify Function to generate presigned URLs for direct R2 uploads
// This allows large files to bypass Netlify's size limits

const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "family-archive-uploads";

// Initialize R2 client
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // Check R2 credentials
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      console.error("Missing R2 credentials");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Storage not configured" }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body);
    const { filename, contentType, size, fileHash } = body;

    if (!filename) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Filename is required" }),
      };
    }

    // Generate object key using file hash if provided, otherwise use timestamp
    // Hash-based keys prevent duplicates (same content = same key)
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    let objectKey;

    if (fileHash) {
      // Use provided hash for deduplication
      objectKey = `Memorial_Guest_UPLOADS/${fileHash}_${safeFilename}`;

      // Check if file already exists
      try {
        await r2Client.send(new HeadObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: objectKey,
        }));
        // File already exists - return skip response
        console.log(`Skipped duplicate: ${objectKey}`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            skipped: true,
            objectKey: objectKey,
            message: "File already exists",
          }),
        };
      } catch (err) {
        // File doesn't exist, proceed
      }
    } else {
      // Fallback to timestamp-based key (for backwards compatibility)
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      objectKey = `Memorial_Guest_UPLOADS/${timestamp}_${safeFilename}`;
    }

    // Create presigned URL for direct upload (valid for 1 hour)
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: objectKey,
      ContentType: contentType || "application/octet-stream",
    });

    const presignedUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });

    console.log(`Generated presigned URL for: ${objectKey} (${size} bytes)`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        uploadUrl: presignedUrl,
        objectKey: objectKey,
        expiresIn: 3600,
      }),
    };

  } catch (error) {
    console.error("Error generating presigned URL:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to generate upload URL: " + error.message }),
    };
  }
};
