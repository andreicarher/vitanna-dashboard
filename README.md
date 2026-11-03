# Vitanna · Dashboard de performance

Dashboard estático (un solo `index.html`, Chart.js por CDN, sin build) que lee Meta Ads, Google Ads, TikTok Ads y Shopify a través de cuatro funciones serverless en Vercel. Las credenciales viven solo en las variables de entorno de Vercel; el navegador nunca las ve.

```
index.html              ← todo el dashboard
api/meta-data.js        ← Meta Marketing API (Insights)
api/google-ads-data.js  ← Google Ads REST API
api/tiktok-data.js      ← TikTok API for Business v1.3
api/shopify-data.js     ← Shopify Admin GraphQL
lib/common.js           ← rango de fechas, caché, errores, clave opcional
test/run-tests.mjs      ← pruebas con respuestas simuladas (npm test)
```

Cada función devuelve el mismo formato (`date, campaign, spend, impressions, clicks, conversions, revenue`), así que agregar otra plataforma es escribir una función más y sumarla a `PLATFORMS` en `index.html`.

## Despliegue (GitHub + Vercel)

1. Crea un repo en GitHub y sube esta carpeta tal cual (el `.gitignore` ya excluye `.env`).
2. En Vercel: **Add New → Project → Import** el repo. Framework preset: **Other**. Sin build command ni output directory.
3. En **Settings → Environment Variables** pega las variables de `.env.example` con sus valores reales (Production y Preview).
4. Deploy. Cada `git push` a `main` vuelve a desplegar.
5. Abre la URL. Las fuentes que aún no tengan credenciales aparecen en rojo con el nombre exacto de la variable que falta; el resto del dashboard funciona igual.

**Protección:** el dashboard expone inversión y ventas. Define `DASHBOARD_KEY` (el navegador la pide una vez y la guarda) o activa *Deployment Protection* en Vercel.

## Credenciales por plataforma

### Meta Ads
- En Business Manager → Usuarios del sistema, crea un **System User**, asígnale la cuenta publicitaria y genera un token con `ads_read`. Este token no expira; uno de usuario normal caduca en ~60 días.
- `META_AD_ACCOUNT_ID`: solo números (si pegas `act_123…` también funciona).
- `META_API_VERSION`: por defecto `v26.0`. Las versiones de Marketing API caducan rápido; cuando Meta deprecie una, solo se cambia esta variable.
- `META_PURCHASE_ACTION`: qué cuenta como compra. Confirmado: solo el evento de compra del píxel (`offsite_conversion.fb_pixel_purchase`).

### Google Ads
- Desde septiembre de 2026, el acceso se aprueba por proyecto de Google Cloud (nivel Explorer o superior). El código actual aún requiere GOOGLE_ADS_DEVELOPER_TOKEN aunque Google ya no lo usa; mantener la variable hasta actualizarlo.
- OAuth Client ID tipo **Aplicación web** (no "Escritorio"), con `https://developers.google.com/oauthplayground` como URI de redirección autorizada. Con un cliente de escritorio el Playground falla con `redirect_uri_mismatch`.
- Refresh token: OAuth Playground → engrane → "Use your own OAuth credentials" → scope `https://www.googleapis.com/auth/adwords` → autorizar → intercambiar código.
- Customer ID y Login Customer ID sin guiones (el código los quita por si acaso).
- `GOOGLE_ADS_API_VERSION`: revisa la versión vigente en la documentación de Google Ads antes del primer deploy.
- Compras y valor: solo la acción «Google Shopping App Purchase», con métricas all_conversions y all_conversions_value de Google (fecha de interacción). Consulta independiente de la inversión para evitar duplicarla. Si no se encuentra una única acción con ese nombre, la fuente falla en lugar de mostrar ceros. Comparar con Google Ads por acción, periodo, ventana de atribución y campañas; no son pedidos totales Shopify.

### TikTok Ads
- En TikTok for Business Developers crea una app con permiso de **Reporting** y autorízala sobre el advertiser para obtener el access token.
- `TIKTOK_ADVERTISER_ID`: el ID de la cuenta publicitaria.
- Las métricas de compras son configurables: por defecto `complete_payment` (número) y `total_complete_payment_rate`, que es el nombre en la API de "Total complete payment value" en Ads Manager.

### Shopify
Desde el 1 de enero de 2026 ya no se pueden crear apps custom desde el admin de la tienda.
- **App nueva (recomendado):** créala en el Dev Dashboard (`dev.shopify.com`) dentro de la misma organización dueña de la tienda, con scopes `read_orders` y `read_all_orders`, instálala en la tienda y copia Client ID y Client Secret. La función obtiene el token con *client credentials* y lo renueva sola (dura ~24 h).
- **App legacy existente:** si ya existe una creada antes de 2026, basta con su token en `SHOPIFY_ACCESS_TOKEN`.
- Sin `read_all_orders`, Shopify solo devuelve pedidos de los últimos 60 días y el año se vería incompleto sin marcar error.

## Supuestos que hay que confirmar con Vitanna

Están en el objeto `CONFIG` de `index.html` y en las variables de entorno; cambiar cualquiera es una línea.

1. **Confirmado:** ventas de productos sin IVA ni envío, netas de reembolsos; sin pedidos de prueba ni cancelados.
2. **Campañas de Amazon:** las que llevan "Amazon" en el nombre (Tráfico Amazon, Gdemand - Amazon, Tráfico - Amazon) se excluyen de las métricas de medios visibles y del ROAS total. El filtro por nombre es imperfecto: verificar el destino de cada campaña.
3. **Clics de Meta:** se usan clics en el enlace, comparables con los de Google y TikTok, no "clics (todos)".
4. ~~Moneda y zona horaria~~ **Confirmado:** MXN y hora de Ciudad de México. Si alguna fuente reporta otra moneda, el dashboard muestra una alerta.
5. **Historial:** se descarga desde el 1 de enero de 2026, en ventanas sucesivas de hasta 365 días. La comparación con el periodo anterior se muestra solo cuando ese periodo cae dentro de lo descargado.

## Desarrollo local

```bash
npm test          # pruebas de las 4 funciones con respuestas simuladas
npx vercel dev    # sirve index.html + /api con tu .env local
```

La caché de cada función dura 15 minutos por instancia; el botón "Actualizar datos" la salta.

## Estado de revisión · 3 noviembre 2026

Este paquete es una base local: no hay despliegue ni conexiones reales verificadas. Las pruebas usan respuestas simuladas. Antes de uso real:

- Configurar y comprobar protección efectiva en el despliegue y las API. Sin DASHBOARD_KEY ni protección de Vercel la API queda abierta. La clave compartida se guarda en el navegador y no equivale a accesos individuales ni permisos por usuario.
- El cálculo usa el subtotal de productos y sus líneas de impuesto para excluir envío e IVA; debe validarse con pedidos reales (IVA incluido/no incluido, descuentos, reembolsos y ajustes) y conciliarse con Shopify antes de usarlo para decisiones. Las ventas y los reembolsos se agrupan por fecha de creación del pedido, no por fecha del reembolso, y pueden cambiar retrospectivamente. El subtotal original con IVA es posterior a descuentos y anterior a reembolsos: no equivale necesariamente a «ventas brutas» del informe Shopify. Los reembolsos totales del pedido pueden incluir envío e impuestos.
- Validar zona horaria y moneda de las cuatro cuentas, integridad del historial y scopes de Shopify, métricas de conversión y valor de TikTok, y configuración de conversiones de Google; puede incluir microconversiones. No sumar atribuciones de plataformas como si fueran pedidos únicos.
- El ROAS total es ventas Shopify / gasto de campañas no identificadas como Amazon (MER), no ROAS atribuible a pauta. No puede calcularse de forma fiable con fuentes ausentes o divisas distintas. La identificación por nombre puede omitir campañas Amazon o clasificar mal otras.
- Sin cron o almacenamiento persistente: la caché de 15 minutos es por instancia y los datos se consultan al abrir o actualizar. Validar límites de API, paginación, rendimiento y tiempo de ejecución con datos reales; el incremento de histórico puede afectar duración y cuota.
- Verificar clics de enlace Meta y el plan aprobado. Amazon no se incluye; unidades por pedido y avance vs. plan siguen pendientes. Audiencia: equipo y cliente.

## Google Analytics 4

El conector usa la Google Analytics Data API y una cuenta de servicio dedicada con acceso Lector a la propiedad GA4. Configura en Vercel Production `GA4_PROPERTY_ID` (ID numérico de propiedad, no ID G-), `GA4_CLIENT_EMAIL` y `GA4_PRIVATE_KEY` (clave privada PEM de esa cuenta). No subas la clave al repositorio. Después de modificar variables, despliega de nuevo. La cuenta necesita acceso a la propiedad correcta; habilitar la API no otorga acceso por sí mismo.

Consulta usuarios activos y sesiones para el rango completo (usuarios no se suman por día) y sesiones por grupo de canales predeterminado. La comparación usa otro reporte del periodo anterior cuando este queda dentro del histórico desde 2026-01-01. La zona horaria depende de la propiedad GA4. Las ventas y el ROAS siguen usando Shopify y Ads, no GA4. Valida frente a GA4 con los mismos rangos, zona horaria, definición de canal y posibles retrasos, umbrales o muestreo. El caché es de 15 minutos por instancia y rango; Actualizar datos lo omite.
