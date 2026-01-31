// Netlify Function to upload photos to Cloudflare R2
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const busboy = require("busboy");

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "family-archive-uploads";

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
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

  // Check R2 credentials
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error("Missing R2 credentials:", {
      hasAccountId: !!R2_ACCOUNT_ID,
      hasAccessKey: !!R2_ACCESS_KEY_ID,
      hasSecretKey: !!R2_SECRET_ACCESS_KEY,
    });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Storage not configured. Missing R2 credentials." }),
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

    // Parse multipart form data
    const { files, fields } = await parseMultipartForm(event);

    if (files.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No files uploaded" }),
      };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const contributorName = fields.contributor || "Memorial_Guest";
    const folderName = `${contributorName.replace(/[^a-zA-Z0-9]/g, "_")}_UPLOADS`;

    const uploadedFiles = [];

    for (const file of files) {
      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectKey = `${folderName}/${timestamp}_${safeFilename}`;

      const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: file.content,
        ContentType: file.mimeType,
      });

      await r2Client.send(command);

      uploadedFiles.push({
        filename: file.filename,
        objectKey: objectKey,
        size: file.content.length,
      });

      console.log(`Uploaded: ${objectKey} (${file.content.length} bytes)`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `${uploadedFiles.length} photo(s) uploaded successfully`,
        files: uploadedFiles,
      }),
    };
  } catch (error) {
    console.error("Upload error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Upload failed: " + error.message }),
    };
  }
};

// Parse multipart form data using busboy
function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];

    const contentType = event.headers["content-type"] || event.headers["Content-Type"];

    const bb = busboy({ headers: { "content-type": contentType } });

    bb.on("file", (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];

      file.on("data", (data) => {
        chunks.push(data);
      });

      file.on("end", () => {
        files.push({
          fieldname: name,
          filename,
          mimeType,
          content: Buffer.concat(chunks),
        });
      });
    });

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("finish", () => {
      resolve({ files, fields });
    });

    bb.on("error", (error) => {
      reject(error);
    });

    // Get the body as a buffer
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body || "");

    bb.end(body);
  });
}
