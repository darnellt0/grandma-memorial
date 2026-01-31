// Netlify Function to fetch photos from R2 for the memorial gallery
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "family-archive-uploads";

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Check for required environment variables
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error("Missing R2 credentials");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server configuration error" }),
    };
  }

  try {
    // Initialize R2 client
    const r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    // List all objects in the bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      MaxKeys: 100, // Limit to 100 photos for performance
    });

    const listResponse = await r2Client.send(listCommand);
    const objects = listResponse.Contents || [];

    // Filter for image and video files only
    const mediaExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.mp4', '.mov', '.webm'];
    const mediaFiles = objects.filter(obj => {
      const key = obj.Key.toLowerCase();
      return mediaExtensions.some(ext => key.endsWith(ext));
    });

    // Sort by last modified (newest first)
    mediaFiles.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

    // Generate signed URLs for each file (valid for 1 hour)
    const photos = await Promise.all(
      mediaFiles.slice(0, 50).map(async (obj) => {
        const getCommand = new GetObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: obj.Key,
        });

        const signedUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 3600 });

        // Extract filename and contributor from key
        const parts = obj.Key.split('/');
        const contributor = parts[0].replace('_UPLOADS', '').replace(/_/g, ' ');
        const filename = parts[parts.length - 1];

        // Check if it's a video
        const isVideo = ['.mp4', '.mov', '.webm'].some(ext =>
          obj.Key.toLowerCase().endsWith(ext)
        );

        // Check if it's HEIC
        const isHeic = ['.heic', '.heif'].some(ext =>
          obj.Key.toLowerCase().endsWith(ext)
        );

        return {
          key: obj.Key,
          url: signedUrl,
          filename,
          contributor,
          size: obj.Size,
          lastModified: obj.LastModified,
          isVideo,
          isHeic,
        };
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        photos,
        total: photos.length,
      }),
    };

  } catch (error) {
    console.error("Gallery fetch error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Failed to fetch gallery",
        details: error.message
      }),
    };
  }
};
