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
ENV JWT_SECRET=your_jwt_secret_key_here
ENV REP_PROFILE_API=https://api-repcreationwizard.harx.ai/api 

# Expose port
EXPOSE 5008

# Start the application
CMD ["npm", "start"]
