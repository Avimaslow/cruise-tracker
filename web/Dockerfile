FROM nginx:alpine

# Copy your static site into nginx
COPY . /usr/share/nginx/html

# Cloud Run expects the container to listen on $PORT (we’ll use 8080)
EXPOSE 8080

# Make nginx listen on 8080 instead of 80, then run it
CMD ["sh", "-c", "sed -i 's/listen\\s\\+80;/listen 8080;/g' /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
