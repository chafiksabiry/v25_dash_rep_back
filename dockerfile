# Use Node.js LTS version
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Set environment variables
ENV PORT=5008
ENV JWT_SECRET=my_super_secret_key_12345
ENV REP_PROFILE_API=https://preprod-api-repcreationwizard.harx.ai/api 

# Expose port
EXPOSE 5008

# Start the application
CMD ["npm", "start"]
