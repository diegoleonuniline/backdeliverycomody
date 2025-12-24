const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// MySQL Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'u951308636_comody',
  password: process.env.DB_PASSWORD || 'AbCloud2018#',
  database: process.env.DB_NAME || 'u951308636_comody',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// AppSheet Config (SOLO PRODUCTOS)
const APPSHEET_APP_ID = process.env.APPSHEET_APP_ID || "73c158ba-ee52-46ac-bb8a-d5de9288dba7";
const APPSHEET_API_KEY = process.env.APPSHEET_API_KEY || "V2-VLqAc-tCJpO-rs1pU-XT4fq-IMOyy-jOlUq-YbEyf-i6rEk";
const APPSHEET_BASE_URL = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/`;

app.use(cors());
app.use(express.json());

function getHeaders() {
  return {
    "ApplicationAccessKey": APPSHEET_API_KEY,
    "Content-Type": "application/json"
  };
}

function buildFindPayload(selector) {
  const payload = {
    Action: "Find",
    Properties: { Locale: "es-MX", Timezone: "America/Mexico_City" },
    Rows: []
  };
  if (selector) payload.Properties.Selector = selector;
  return payload;
}

async function appSheetFind(tableName, selector) {
  const res = await fetch(APPSHEET_BASE_URL + tableName + "/Action", {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(buildFindPayload(selector))
  });
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ========================================
// ENDPOINTS DELIVERY
// ========================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Delivery Backend Running' });
});

app.get('/api/menu', async (req, res) => {
    try {
        // AppSheet: Productos, Extras, ProductoExtras, Banners, Cupones, Promociones
        const [rawProductos, rawExtras, rawProductoExtras, rawBanners, rawCupones, rawPromociones, rawPromoProductos] = await Promise.all([
            appSheetFind("Productos"),
            appSheetFind("Extras"),
            appSheetFind("ProductoExtras"),
            appSheetFind("Banners"),
            appSheetFind("Cupones"),
            appSheetFind("Promociones"),
            appSheetFind("PromocionProductos")
        ]);

        // MySQL: Solo Categorías
        const [categorias] = await pool.query("SELECT * FROM categorias WHERE activo = 'SI' ORDER BY icono");

        const categoriasFormat = categorias.map(r => ({
            id: r.id,
            nombre: r.nombre || "",
            icono: r.icono || "📦",
            orden: 99
        }));

        const productos = rawProductos
            .filter(r => r.Disponible && r.Disponible.toUpperCase() === "SI")
            .map(r => {
                let imagen = "";
                const urlProducto = r.URL_Producto || "";
                if (urlProducto && urlProducto.includes("fileName=")) {
                    const fileName = urlProducto.split("fileName=")[1];
                    if (fileName && fileName.trim() && !fileName.startsWith("&")) {
                        imagen = urlProducto;
                    }
                }
                return {
                    id: r.ID,
                    nombre: r.Nombre,
                    descripcion: r.Descripcion || "",
                    precio: parseFloat(r.Precio) || 0,
                    categoria: r.Categoria,
                    imagen,
                    tiempo: r.TiempoPreparacion || "15 min",
                    tieneExtras: r.TieneExtras && r.TieneExtras.toUpperCase() === "SI",
                    destacado: r.Destacado && r.Destacado.toLowerCase() === "si"
                };
            });

        const destacados = productos.filter(p => p.destacado);

        const extras = rawExtras
            .filter(r => r.Disponible && r.Disponible.toUpperCase() === "SI")
            .map(r => ({
                id: r.ID,
                nombre: r.Nombre,
                precio: parseFloat(r.Precio) || 0
            }));

        const productoExtras = rawProductoExtras.map(r => ({
            productoId: r.ProductoID,
            extraId: r.ExtraID
        }));

        // Banners por posición
        const bannersPrincipal = [];
        const bannersSecundario = [];
        const bannersTerciario = [];

        rawBanners.forEach(b => {
            if (b.Activo && b.Activo.toLowerCase() === "si" && b.Banner_URL) {
                const banner = { id: b.ID, url: b.Banner_URL };
                const pos = (b.Posicion || "Principal").toLowerCase();
                
                if (pos === "secundario") bannersSecundario.push(banner);
                else if (pos === "terciario") bannersTerciario.push(banner);
                else bannersPrincipal.push(banner);
            }
        });

        // Promociones
        const hoy = new Date();
        const productosMap = {};
        rawProductos.forEach(p => productosMap[p.ID] = p.Nombre || "Producto");

        const promocionesFormat = rawPromociones
            .filter(promo => {
                if (!promo.Activo || promo.Activo.toLowerCase() !== "si") return false;
                
                if (promo.FechaInicio) {
                    const inicio = new Date(promo.FechaInicio);
                    if (hoy < inicio) return false;
                }
                if (promo.FechaFin) {
                    const fin = new Date(promo.FechaFin);
                    fin.setHours(23, 59, 59);
                    if (hoy > fin) return false;
                }
                return true;
            })
            .map(promo => {
                const productosPromo = rawPromoProductos
                    .filter(pp => pp.PromocionID === promo.ID)
                    .map(pp => ({
                        productoId: pp.ProductoID,
                        nombreProducto: productosMap[pp.ProductoID] || "Producto",
                        cantidad: parseInt(pp.Cantidad) || 1
                    }));

                const precioNormal = parseFloat(promo.PrecioNormal) || 0;
                const precioPromo = parseFloat(promo.PrecioPromo) || 0;
                const ahorro = precioNormal - precioPromo;
                const descuentoPct = precioNormal > 0 ? Math.round((ahorro / precioNormal) * 100) : 0;

                return {
                    id: promo.ID,
                    nombre: promo.Nombre || "",
                    descripcion: promo.Descripcion || "",
                    imagen: promo.ImagenUrl || "",
                    precioNormal,
                    precioPromo,
                    ahorro,
                    descuentoPct,
                    productos: productosPromo,
                    orden: parseInt(promo.Orden) || 99,
                    fechaFin: promo.FechaFin || ""
                };
            })
            .sort((a, b) => a.orden - b.orden);

        res.json({
            categorias: categoriasFormat,
            productos,
            destacados,
            extras,
            productoExtras,
            banners: bannersPrincipal,
            bannersSecundario,
            bannersTerciario,
            promociones: promocionesFormat
        });

    } catch (error) {
        console.error('ERROR /api/menu:', error);
        res.status(500).json({ error: error.message });
    }
});

// LOGIN CLIENTE - MySQL
app.post('/api/auth/login', async (req, res) => {
  try {
    const { correo, contrasena } = req.body;
    
    const [clientes] = await pool.query(
      "SELECT * FROM clientes WHERE LOWER(correo) = LOWER(?) LIMIT 1",
      [correo.trim()]
    );
    
    if (clientes.length === 0) {
      return res.json({ success: false, mensaje: "Credenciales incorrectas" });
    }
    
    const cliente = clientes[0];
    
    if (String(cliente.contrasena).trim() !== String(contrasena).trim()) {
      return res.json({ success: false, mensaje: "Contraseña incorrecta" });
    }
    
    if (!cliente.activo || cliente.activo.toUpperCase() !== "SI") {
      return res.json({ success: false, mensaje: "Cuenta inactiva" });
    }
    
    res.json({
      success: true,
      sessionId: "sess_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
      mensaje: "¡Bienvenido!",
      cliente: {
        id: cliente.id,
        nombre: cliente.nombre,
        telefono: cliente.telefono,
        correo: cliente.correo,
        direccion: cliente.direccion || "",
        puntos: cliente.puntos || 0
      }
    });
    
  } catch (error) {
    console.error('ERROR login:', error);
    res.status(500).json({ success: false, mensaje: error.message });
  }
});

// REGISTRO CLIENTE - MySQL
app.post('/api/auth/register', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const datos = req.body;
    
    const [existentes] = await conn.query(
      "SELECT * FROM clientes WHERE LOWER(correo) = LOWER(?)",
      [datos.correo]
    );
    
    if (existentes.length > 0) {
      return res.json({ success: false, mensaje: "Este correo ya está registrado" });
    }
    
    const [result] = await conn.query(
      `INSERT INTO clientes (nombre, telefono, correo, direccion, contrasena, puntos, activo) 
       VALUES (?, ?, ?, ?, ?, 0, 'SI')`,
      [datos.nombre, datos.telefono, datos.correo, datos.direccion || "", datos.contrasena]
    );
    
    const [cliente] = await conn.query("SELECT * FROM clientes WHERE id = ?", [result.insertId]);
    
    await conn.commit();
    
    res.json({
      success: true,
      sessionId: "sess_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
      mensaje: "Registro exitoso",
      cliente: {
        id: cliente[0].id,
        nombre: cliente[0].nombre,
        telefono: cliente[0].telefono,
        correo: cliente[0].correo,
        direccion: cliente[0].direccion || "",
        puntos: 0
      }
    });
    
  } catch (error) {
    await conn.rollback();
    console.error('ERROR registrar:', error);
    res.status(500).json({ success: false, mensaje: error.message });
  } finally {
    conn.release();
  }
});

// REGISTRAR PEDIDO - MySQL
app.post('/api/pedidos', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const data = req.body;
    
    // Generar folio
    const [rows] = await conn.query("SELECT folio FROM ventas ORDER BY folio DESC LIMIT 1");
    let folio = "VEN0001";
    if (rows.length > 0) {
      const ultimo = rows[0].folio;
      const num = parseInt(ultimo.substring(3)) + 1;
      folio = "VEN" + num.toString().padStart(4, '0');
    }
    
    const now = new Date();
    const fecha = now.toISOString().slice(0, 19).replace('T', ' ');
    
    let subtotalProductos = 0;
    data.productos.forEach(p => subtotalProductos += p.subtotal);
    
    const costoEnvio = data.tipoServicio === "Domicilio" ? (data.costoEnvio || 0) : 0;
    let descuento = 0;
    let cuponId = null;
    
    if (data.cupon && data.cupon.id) {
      descuento = Math.round(subtotalProductos * (data.cupon.descuento / 100));
      cuponId = data.cupon.id;
    }
    
    const total = subtotalProductos + costoEnvio - descuento;
    
    // Insertar venta
    await conn.query(
      `INSERT INTO ventas (folio, fecha, clienteid, nombrecliente, telefonocliente, direccionentrega, tiposervicio, observaciones, costoenvio, coordenadasentrega, cuponaplicado, descuento, estadodelivery, estado) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Abierto')`,
      [
        folio,
        fecha,
        data.clienteId,
        data.nombreCliente,
        data.telefono || "",
        data.direccion,
        data.tipoServicio,
        data.observaciones || "",
        costoEnvio,
        data.coordenadas || "",
        cuponId,
        descuento,
        data.tipoServicio === "Domicilio" ? "Solicitado" : ""
      ]
    );
    
    // Insertar detalles
    for (const p of data.productos) {
      let extrasStr = "";
      if (p.extras && p.extras.length > 0) {
        extrasStr = p.extras.map(e => e.nombre).join(", ");
      }
      
      await conn.query(
        `INSERT INTO detalleventas (folio, productoid, nombreproducto, cantidad, preciounitario, extras, extrastotal, subtotal, notas) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          folio,
          p.productoId,
          p.nombre,
          p.cantidad,
          p.precio,
          extrasStr,
          p.extrasTotal,
          p.subtotal,
          p.notas || ""
        ]
      );
    }
    
    await conn.commit();
    
    res.json({
      success: true,
      folio,
      total,
      descuento,
      mensaje: "Pedido registrado"
    });
    
  } catch (error) {
    await conn.rollback();
    console.error('ERROR /api/pedidos:', error);
    res.status(500).json({ success: false, mensaje: error.message });
  } finally {
    conn.release();
  }
});

// OBTENER PEDIDOS CLIENTE - MySQL
app.get('/api/pedidos/:clienteId', async (req, res) => {
  try {
    const [ventas] = await pool.query(
      "SELECT * FROM ventas WHERE clienteid = ? ORDER BY fecha DESC, hora DESC",
      [req.params.clienteId]
    );
    
    if (ventas.length === 0) return res.json([]);
    
    const folios = ventas.map(v => v.folio);
    const [detalles] = await pool.query(
      "SELECT * FROM detalleventas WHERE folio IN (?)",
      [folios]
    );
    
    const detallesPorFolio = {};
    detalles.forEach(d => {
      if (!detallesPorFolio[d.folio]) detallesPorFolio[d.folio] = [];
      detallesPorFolio[d.folio].push({
        nombre: d.nombreproducto || "",
        cantidad: parseInt(d.cantidad) || 1,
        extras: d.extras || "",
        subtotal: parseFloat(d.subtotal) || 0
      });
    });
    
    const pedidos = ventas.map(v => ({
      folio: v.folio,
      fecha: v.fecha,
      hora: v.hora,
      tipoServicio: v.tiposervicio,
      estado: v.estado || "Pendiente",
      estadoDelivery: v.estadodelivery || "",
      direccion: v.direccionentrega || "",
      costoEnvio: parseFloat(v.costoenvio) || 0,
      descuento: parseFloat(v.descuento) || 0,
      productos: detallesPorFolio[v.folio] || []
    }));
    
    res.json(pedidos);
    
  } catch (error) {
    console.error('ERROR /api/pedidos:', error);
    res.status(500).json([]);
  }
});

// DIRECCIONES CLIENTE - MySQL
app.get('/api/direcciones/:clienteId', async (req, res) => {
  try {
    const [data] = await pool.query(
      "SELECT * FROM direccionescliente WHERE clientes = ?",
      [req.params.clienteId]
    );
    
    res.json(data.map(d => ({
      id: d.id,
      direccion: d.direccion,
      maps: d.maps || ""
    })));
    
  } catch (error) {
    console.error('ERROR /api/direcciones:', error);
    res.status(500).json([]);
  }
});

// AGREGAR DIRECCION - MySQL
app.post('/api/direcciones', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { clienteId, direccion, maps } = req.body;
    
    const [result] = await conn.query(
      `INSERT INTO direccionescliente (clientes, direccion, maps) VALUES (?, ?, ?)`,
      [clienteId, direccion, maps || ""]
    );
    
    await conn.commit();
    res.json({ success: true, id: result.insertId });
    
  } catch (error) {
    await conn.rollback();
    console.error('ERROR /api/direcciones POST:', error);
    res.json({ success: false, mensaje: error.message });
  } finally {
    conn.release();
  }
});

// EDITAR DIRECCION - MySQL
app.put('/api/direcciones/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    const { direccion, maps } = req.body;
    
    await conn.query(
      "UPDATE direccionescliente SET direccion = ?, maps = ? WHERE id = ?",
      [direccion, maps || "", req.params.id]
    );
    
    await conn.commit();
    res.json({ success: true });
    
  } catch (error) {
    await conn.rollback();
    console.error('ERROR /api/direcciones PUT:', error);
    res.json({ success: false, mensaje: error.message });
  } finally {
    conn.release();
  }
});

// ELIMINAR DIRECCION - MySQL
app.delete('/api/direcciones/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    
    await conn.query("DELETE FROM direccionescliente WHERE id = ?", [req.params.id]);
    
    await conn.commit();
    res.json({ success: true });
    
  } catch (error) {
    await conn.rollback();
    console.error('ERROR /api/direcciones DELETE:', error);
    res.json({ success: false });
  } finally {
    conn.release();
  }
});

app.post('/api/cupones/validar', async (req, res) => {
    try {
        const { codigo, clienteId } = req.body;
        
        const cupones = await appSheetFind('Cupones', `Filter(Cupones, LOWER([CodigoCupon]) = LOWER("${codigo}"))`);
        
        if (cupones.length === 0) {
            return res.json({ success: false, mensaje: "Cupón no válido" });
        }
        
        const c = cupones[0];
        const hoy = new Date();
        
        if (c.Vigencia) {
            const vigencia = new Date(c.Vigencia);
            if (hoy > vigencia) {
                return res.json({ success: false, mensaje: "Este cupón ha expirado" });
            }
        }
        
        const [usosCliente] = await pool.query(
            "SELECT * FROM ventas WHERE cuponaplicado = ? AND clienteid = ?",
            [c.Id, clienteId]
        );
        
        if (usosCliente.length > 0) {
            return res.json({ success: false, mensaje: "Ya usaste este cupón" });
        }
        
        res.json({
            success: true,
            cupon: {
                id: c.Id,
                nombre: c.NombreCupon,
                descuento: parseFloat(c["Descuento%"]) || 0,
                codigo: c.CodigoCupon
            }
        });
        
    } catch (error) {
        console.error('ERROR /api/cupones/validar:', error);
        res.json({ success: false, mensaje: error.message });
    }
});

// VALIDAR CUPON - MySQL
app.post('/api/cupones/validar', async (req, res) => {
  try {
    const { codigo, clienteId } = req.body;
    
    const [cupones] = await pool.query(
      "SELECT * FROM cupones WHERE LOWER(codigocupon) = LOWER(?)",
      [codigo]
    );
    
    if (cupones.length === 0) {
      return res.json({ success: false, mensaje: "Cupón no válido" });
    }
    
    const c = cupones[0];
    const hoy = new Date();
    
    if (c.vigencia) {
      const vigencia = new Date(c.vigencia);
      if (hoy > vigencia) {
        return res.json({ success: false, mensaje: "Este cupón ha expirado" });
      }
    }
    
    const [usosCliente] = await pool.query(
      "SELECT * FROM ventas WHERE cuponaplicado = ? AND clienteid = ?",
      [c.id, clienteId]
    );
    
    if (usosCliente.length > 0) {
      return res.json({ success: false, mensaje: "Ya usaste este cupón" });
    }
    
    res.json({
      success: true,
      cupon: {
        id: c.id,
        nombre: c.nombrecupon,
        descuento: parseFloat(c.descuento) || 0,
        codigo: c.codigocupon
      }
    });
    
  } catch (error) {
    console.error('ERROR /api/cupones/validar:', error);
    res.json({ success: false, mensaje: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Delivery Backend running on port ${PORT}`);
});
