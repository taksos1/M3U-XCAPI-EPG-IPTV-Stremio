# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy the rest of the code
COPY . .

# Expose the default port
EXPOSE 7000

# Start the server
CMD ["npm", "start"]
