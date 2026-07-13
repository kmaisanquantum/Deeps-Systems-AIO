# ==========================================
# Step 1: Builder stage
# ==========================================
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /usr/src/app

# Copy package manifest files
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy the rest of the application code
COPY . .

# Prune dev dependencies to keep production image light
RUN npm prune --omit=dev

# ==========================================
# Step 2: Runner stage
# ==========================================
FROM node:20-alpine AS runner

# Set production environment and port
ENV NODE_ENV=production
ENV PORT=3000

# Set the working directory
WORKDIR /usr/src/app

# Copy the entire pruned workspace from the builder stage
# This includes production node_modules, package.json, index.js,
# and any custom server files or middleware maps.
COPY --from=builder /usr/src/app .

# Expose port 3000 as requested
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
