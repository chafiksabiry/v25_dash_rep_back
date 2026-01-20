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
PORT=5008
JWT_SECRET=your_jwt_secret_key_here
REP_PROFILE_API=https://api-repcreationwizard.harx.ai/api 
FRONT_URL=https://harxv25dashboardrepfront.netlify.app/
QIANKUN_MAIN_APP_URL=https://v25.harx.ai


# Start the application
CMD ["npm", "start"]
