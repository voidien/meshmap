FROM python:3.12-slim
RUN pip install --no-cache-dir numpy Pillow rasterio laspy[lazrs] pyarrow shapely
WORKDIR /app
COPY pyproject.toml ./
COPY meshmap_etl ./meshmap_etl
RUN pip install --no-cache-dir --no-deps .
ENTRYPOINT ["meshmap-etl"]
