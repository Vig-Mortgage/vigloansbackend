module.exports = {
  apps: [{
    name: "vigloans-backend-v2",
    script: "app.js",
    env: {
      PORT: 8081,
      AWS_REGION: process.env.AWS_REGION || 'us-east-1',
      // Secrets Manager
      SM_AWS_ACCESS_KEY_ID: process.env.SM_AWS_ACCESS_KEY_ID,
      SM_AWS_SECRET_ACCESS_KEY: process.env.SM_AWS_SECRET_ACCESS_KEY,
      // S3
      S3_AWS_ACCESS_KEY_ID: process.env.S3_AWS_ACCESS_KEY_ID,
      S3_AWS_SECRET_ACCESS_KEY: process.env.S3_AWS_SECRET_ACCESS_KEY,
    }
  }]
}
