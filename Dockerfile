FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data && chmod 777 /app/data
ENV PORT=7860
EXPOSE 7860
CMD ["npm", "start"]
