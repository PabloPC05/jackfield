# Build once, run anywhere that has a container runtime.
#   docker build -f deploy/docker/Dockerfile -t jackfield .
#   docker run --rm -p 8790:8790 -v "$PWD/jackfield.yaml:/etc/jackfield/jackfield.yaml:ro" jackfield

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN addgroup -S jackfield && adduser -S -G jackfield jackfield
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/package.json ./package.json
USER jackfield
ENV JACKFIELD_CONFIG=/etc/jackfield/jackfield.yaml
EXPOSE 8790
# 0.0.0.0 inside the container; publish it behind your own proxy.
ENTRYPOINT ["node", "packages/cli/dist/bin.js"]
CMD ["serve", "--host", "0.0.0.0"]
