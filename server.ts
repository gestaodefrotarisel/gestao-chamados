import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

dotenv.config();

// Inicialização opcional e resiliente do Firebase Firestore
let db: any = null;
let isFirebaseConfigured = false;

try {
  let projectId = process.env.FIREBASE_PROJECT_ID;
  let databaseId = process.env.FIREBASE_DATABASE_ID || process.env.FIREBASE_FIRESTORE_DATABASE_ID;

  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      projectId = projectId || config.projectId;
      databaseId = databaseId || config.firestoreDatabaseId;
    } catch (e) {
      console.warn("Falha ao ler firebase-applet-config.json:", e);
    }
  }

  if (projectId) {
    const configOptions: admin.AppOptions = {
      projectId: projectId,
    };

    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountKey) {
      try {
        const credentials = JSON.parse(serviceAccountKey.trim());
        // Garante que eventuais quebras de linha escapadas como '\\n' no Render sejam convertidas para quebras reais '\n'
        if (credentials.private_key) {
          credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
        }
        configOptions.credential = (admin as any).credential.cert(credentials);
      } catch (err) {
        console.error("Erro ao analisar a variável FIREBASE_SERVICE_ACCOUNT_KEY:", err);
      }
    }

    const app = admin.initializeApp(configOptions);
    
    db = getFirestore(app, databaseId || undefined);
    isFirebaseConfigured = true;
    console.log(`Firebase Firestore inicializado com sucesso! Project ID: ${projectId}, ID do Banco: ${databaseId || "(default)"}${serviceAccountKey ? " (Utilizando Service Account)" : ""}`);
  } else {
    console.warn("Nenhuma configuração do Firebase encontrada (arquivo ou variáveis de ambiente). Utilizando armazenamento em memória de fallback.");
  }
} catch (err) {
  console.error("Erro ao inicializar Firebase Admin:", err);
}

// Armazenamento em memória do servidor caso o Firebase não esteja ativo ou falhe
let ticketsMemoryFallback: any[] = [];
let maintenanceItemsMemoryFallback: any[] = [];
let operationalBasesMemoryFallback: any[] = [];
let urgencyConfigsMemoryFallback: any[] = [];
let adminUsersMemoryFallback: any[] = [];

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Permite payloads maiores para suportar anexos de imagem se necessário
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // --- ROTAS DO FIREBASE / TICKETS ---

  // Obter status da integração para exibir ao administrador se desejado
  app.get("/api/db-status", (req, res) => {
    res.json({
      configured: isFirebaseConfigured,
      provider: isFirebaseConfigured ? "Firebase Firestore (Nuvem)" : "Local Storage / Memória Fallback"
    });
  });

  // Obter todos os chamados
  app.get("/api/tickets", async (req, res) => {
    try {
      if (db) {
        const snapshot = await db.collection("tickets").get();
        // Em Firestore, ordenamos em memória de forma confiável e rápida
        const tickets = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
        tickets.sort((a: any, b: any) => {
          return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        });
        return res.json(tickets);
      } else {
        return res.json(ticketsMemoryFallback);
      }
    } catch (err: any) {
      console.error("Exceção na rota GET /api/tickets:", err);
      return res.json(ticketsMemoryFallback);
    }
  });

  // Sincronizar estado inicial do frontend (se o banco estiver vazio, aceita os padrões do localStorage)
  app.post("/api/tickets/sync", async (req, res) => {
    try {
      const { tickets } = req.body;
      if (!Array.isArray(tickets)) {
        return res.status(400).json({ error: "Lista de tickets inválida" });
      }

      ticketsMemoryFallback = [...tickets];

      if (db) {
        const ticketsRef = db.collection("tickets");
        const snapshot = await ticketsRef.limit(1).get();

        if (snapshot.empty) {
          const realTickets = tickets.filter((t: any) => !t.id.startsWith("dummy_") && !t.id.startsWith("ticket_1"));
          if (realTickets.length > 0) {
            const batch = db.batch();
            realTickets.forEach((t: any) => {
              const ref = ticketsRef.doc(t.id);
              batch.set(ref, t);
            });
            await batch.commit();
            console.log(`Sincronizados ${realTickets.length} tickets reais com o Firestore!`);
          }
        }
      }
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Erro na sincronização de dados:", err);
      return res.json({ success: true });
    }
  });

  // --- ROTAS DO FIREBASE / CADASTROS OPERACIONAIS DO MENU ADMIN ---

  // 1. Itens Prediais de Manutenção
  app.get("/api/maintenance-items", async (req, res) => {
    try {
      if (db) {
        const snapshot = await db.collection("maintenance_items").get();
        const items = snapshot.docs.map((doc: any) => doc.data());
        items.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
        return res.json(items);
      }
      return res.json(maintenanceItemsMemoryFallback);
    } catch (err: any) {
      console.error("Exceção na rota GET /api/maintenance-items:", err);
      return res.json(maintenanceItemsMemoryFallback);
    }
  });

  app.post("/api/maintenance-items/sync", async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: "Dados inválidos" });
      
      maintenanceItemsMemoryFallback = [...items];

      if (db) {
        const colRef = db.collection("maintenance_items");
        const snapshot = await colRef.get();
        const batch = db.batch();
        
        snapshot.docs.forEach((doc: any) => batch.delete(doc.ref));
        items.forEach((item: any) => {
          const ref = colRef.doc(item.id || item.name);
          batch.set(ref, item);
        });
        await batch.commit();
      }
      return res.json({ success: true, data: maintenanceItemsMemoryFallback });
    } catch (err: any) {
      console.error("Erro ao salvar itens prediais:", err);
      return res.json({ success: true, data: maintenanceItemsMemoryFallback });
    }
  });

  // 2. Bases Operacionais
  app.get("/api/operational-bases", async (req, res) => {
    try {
      if (db) {
        const snapshot = await db.collection("operational_bases").get();
        const bases = snapshot.docs.map((doc: any) => doc.data());
        bases.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
        return res.json(bases);
      }
      return res.json(operationalBasesMemoryFallback);
    } catch (err: any) {
      console.error("Exceção na rota GET /api/operational-bases:", err);
      return res.json(operationalBasesMemoryFallback);
    }
  });

  app.post("/api/operational-bases/sync", async (req, res) => {
    try {
      const { bases } = req.body;
      if (!Array.isArray(bases)) return res.status(400).json({ error: "Dados inválidos" });

      operationalBasesMemoryFallback = [...bases];

      if (db) {
        const colRef = db.collection("operational_bases");
        const snapshot = await colRef.get();
        const batch = db.batch();
        
        snapshot.docs.forEach((doc: any) => batch.delete(doc.ref));
        bases.forEach((base: any) => {
          const ref = colRef.doc(base.id || base.name);
          batch.set(ref, base);
        });
        await batch.commit();
      }
      return res.json({ success: true, data: operationalBasesMemoryFallback });
    } catch (err: any) {
      console.error("Erro ao salvar bases operacionais:", err);
      return res.json({ success: true, data: operationalBasesMemoryFallback });
    }
  });

  // 3. Configurações de Urgência
  app.get("/api/urgency-configs", async (req, res) => {
    try {
      if (db) {
        const snapshot = await db.collection("urgency_configs").get();
        const configs = snapshot.docs.map((doc: any) => doc.data());
        return res.json(configs);
      }
      return res.json(urgencyConfigsMemoryFallback);
    } catch (err: any) {
      console.error("Exceção na rota GET /api/urgency-configs:", err);
      return res.json(urgencyConfigsMemoryFallback);
    }
  });

  app.post("/api/urgency-configs/sync", async (req, res) => {
    try {
      const { configs } = req.body;
      if (!Array.isArray(configs)) return res.status(400).json({ error: "Dados inválidos" });

      urgencyConfigsMemoryFallback = [...configs];

      if (db) {
        const colRef = db.collection("urgency_configs");
        const snapshot = await colRef.get();
        const batch = db.batch();
        
        snapshot.docs.forEach((doc: any) => batch.delete(doc.ref));
        configs.forEach((config: any) => {
          const ref = colRef.doc(config.id || config.priority);
          batch.set(ref, config);
        });
        await batch.commit();
      }
      return res.json({ success: true, data: urgencyConfigsMemoryFallback });
    } catch (err: any) {
      console.error("Erro ao salvar configurações de urgência:", err);
      return res.json({ success: true, data: urgencyConfigsMemoryFallback });
    }
  });

  // 4. Administradores / Gestores de Frota
  app.get("/api/admin-users", async (req, res) => {
    try {
      if (db) {
        const snapshot = await db.collection("admin_users").get();
        const users = snapshot.docs.map((doc: any) => doc.data());
        users.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
        return res.json(users);
      }
      return res.json(adminUsersMemoryFallback);
    } catch (err: any) {
      console.error("Exceção na rota GET /api/admin-users:", err);
      return res.json(adminUsersMemoryFallback);
    }
  });

  app.post("/api/admin-users/sync", async (req, res) => {
    try {
      const { users } = req.body;
      if (!Array.isArray(users)) return res.status(400).json({ error: "Dados inválidos" });

      adminUsersMemoryFallback = [...users];

      if (db) {
        const colRef = db.collection("admin_users");
        const snapshot = await colRef.get();
        const batch = db.batch();
        
        snapshot.docs.forEach((doc: any) => batch.delete(doc.ref));
        users.forEach((user: any) => {
          const ref = colRef.doc(user.id || user.username);
          batch.set(ref, user);
        });
        await batch.commit();
      }
      return res.json({ success: true, data: adminUsersMemoryFallback });
    } catch (err: any) {
      console.error("Erro ao salvar administradores:", err);
      return res.json({ success: true, data: adminUsersMemoryFallback });
    }
  });


  // Cadastrar novo chamado
  app.post("/api/tickets", async (req, res) => {
    try {
      const { ticket } = req.body;
      if (!ticket || !ticket.id) {
        return res.status(400).json({ error: "Dados do chamado inválidos." });
      }

      ticketsMemoryFallback = [ticket, ...ticketsMemoryFallback.filter(t => t.id !== ticket.id)];

      if (db) {
        try {
          await db.collection("tickets").doc(ticket.id).set(ticket);
          return res.json({ success: true, ticket });
        } catch (error: any) {
          console.error("Erro ao inserir chamado no Firestore:", error);
          return res.json({ success: true, ticket });
        }
      } else {
        return res.json({ success: true, ticket });
      }
    } catch (err: any) {
      console.error("Erro ao salvar chamado:", err);
      return res.json({ success: true, ticket: req.body.ticket });
    }
  });

  // Atualizar chamado
  app.put("/api/tickets/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { ticket } = req.body;
      if (!ticket) {
        return res.status(400).json({ error: "Dados do chamado ausentes." });
      }

      ticketsMemoryFallback = ticketsMemoryFallback.map(t => t.id === id ? ticket : t);

      if (db) {
        try {
          await db.collection("tickets").doc(id).set(ticket, { merge: true });
          return res.json({ success: true, ticket });
        } catch (error: any) {
          console.error("Erro ao atualizar chamado no Firestore:", error);
          return res.json({ success: true, ticket });
        }
      } else {
        return res.json({ success: true, ticket });
      }
    } catch (err: any) {
      console.error("Erro ao atualizar chamado:", err);
      return res.json({ success: true, ticket: req.body.ticket });
    }
  });

  // Excluir chamado individualmente
  app.delete("/api/tickets/:id", async (req, res) => {
    try {
      const { id } = req.params;
      ticketsMemoryFallback = ticketsMemoryFallback.filter(t => t.id !== id);

      if (db) {
        try {
          await db.collection("tickets").doc(id).delete();
          console.log(`Chamado ${id} excluído com sucesso do Firestore.`);
        } catch (error: any) {
          console.error(`Erro ao excluir chamado ${id} do Firestore:`, error);
          return res.status(500).json({ error: "Erro ao excluir no banco de dados." });
        }
      }
      return res.json({ success: true, message: "Chamado excluído com sucesso!" });
    } catch (err: any) {
      console.error("Erro ao excluir chamado:", err);
      return res.status(500).json({ error: "Erro no servidor ao excluir chamado." });
    }
  });

  // Zerar todos os chamados (Banco de Dados de Chamados)
  app.post("/api/tickets/reset", async (req, res) => {
    try {
      ticketsMemoryFallback = [];

      if (db) {
        try {
          const colRef = db.collection("tickets");
          const snapshot = await colRef.get();
          const batch = db.batch();
          snapshot.docs.forEach((doc: any) => batch.delete(doc.ref));
          await batch.commit();
          console.log("Banco de dados de chamados (tickets) zerado com sucesso!");
        } catch (error: any) {
          console.error("Erro ao zerar coleção tickets no Firestore:", error);
          return res.status(500).json({ error: "Erro ao zerar banco de dados na nuvem." });
        }
      }
      return res.json({ success: true, message: "Todos os chamados foram removidos com sucesso!" });
    } catch (err: any) {
      console.error("Erro ao processar reset de chamados:", err);
      return res.status(500).json({ error: "Erro no servidor ao zerar chamados." });
    }
  });

  // Endpoint da API para envio de e-mails de chamados
  app.post("/api/send-email", async (req, res) => {
    try {
      const { ticket, isUpdate, updateMessage } = req.body;
      if (!ticket) {
        return res.status(400).json({ error: "Dados do chamado não informados." });
      }

      const smtpUser = process.env.SMTP_USER || "facilitiesrisel@gmail.com";
      const smtpPass = process.env.SMTP_PASS || "@Cap150957";

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true, // TLS direto na porta 465
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
        tls: {
          rejectUnauthorized: false // Ignora possíveis erros de SSL/TLS self-signed no ambiente Docker
        }
      });

      // Formatar data no padrão brasileiro dd/mm/aaaa hh:mm
      const formatDateBr = (dateStr: string) => {
        if (!dateStr) return "-";
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return dateStr;
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${minutes}`;
      };

      const ticketDateBr = formatDateBr(ticket.createdAt);
      const limitDateBr = formatDateBr(ticket.slaTargetDate);

      // Assunto do E-mail
      const subject = isUpdate 
        ? `[Risel Facilities] Atualização de Status: Chamado ${ticket.id}`
        : `[Risel Facilities] Chamado Registrado com Sucesso: ${ticket.id}`;

      // Corpo em HTML bem desenhado e profissional
      const htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <div style="background-color: #1e293b; padding: 24px; text-align: center; color: #ffffff;">
            <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px;">RISEL FACILITIES</h1>
            <p style="margin: 6px 0 0 0; font-size: 12px; color: #247d52; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Gestão de Manutenção Predial</p>
          </div>
          
          <div style="padding: 28px; color: #334155; line-height: 1.6;">
            ${isUpdate ? `
              <div style="background-color: #f0fdf4; border-left: 4px solid #247d52; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
                <h3 style="margin: 0 0 6px 0; color: #166534; font-size: 15px; font-weight: 800;">Status do Chamado Atualizado!</h3>
                <p style="margin: 0; font-size: 13.5px; color: #15803d; font-weight: 500;">${updateMessage || "O status ou informações do seu chamado de facilities foram atualizados."}</p>
              </div>
            ` : `
              <p style="font-size: 15px; margin-top: 0; color: #1e293b;">Olá, <strong>${ticket.requesterName}</strong>,</p>
              <p style="font-size: 14px; color: #475569;">Confirmamos o registro do seu chamado de manutenção preventiva/corretiva na base da Risel. Uma notificação foi enviada ao time operacional.</p>
            `}

            <div style="background-color: #f8fafc; border: 1px solid #f1f5f9; border-radius: 12px; padding: 20px; margin: 24px 0;">
              <h2 style="margin: 0 0 14px 0; font-size: 13px; color: #1e293b; border-bottom: 2px solid #f1f5f9; padding-bottom: 8px; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Especificações da Solicitação</h2>
              
              <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600; width: 150px;">Código do Chamado:</td>
                  <td style="padding: 8px 0; color: #247d52; font-weight: 800; font-family: monospace; font-size: 15px;">${ticket.id}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Status Atual:</td>
                  <td style="padding: 8px 0;">
                    <span style="background-color: #f1f5f9; color: #1e293b; border: 1px solid #cbd5e1; padding: 3px 10px; border-radius: 8px; font-weight: 700; font-size: 11px;">
                      ${ticket.status}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Item Predial:</td>
                  <td style="padding: 8px 0; font-weight: bold; color: #1e293b;">${ticket.category}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Subitem / Problema:</td>
                  <td style="padding: 8px 0; color: #334155;">${ticket.subitem || "Geral"}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Prioridade:</td>
                  <td style="padding: 8px 0; color: #b91c1c; font-weight: 700;">${ticket.priority}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Base Operacional:</td>
                  <td style="padding: 8px 0; color: #334155; font-weight: 500;">${ticket.operationalBase || "Risel"}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Setor / Local:</td>
                  <td style="padding: 8px 0; color: #334155; font-weight: 500;">${ticket.location}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Data de Abertura:</td>
                  <td style="padding: 8px 0; color: #334155;">${ticketDateBr}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Prazo SLA:</td>
                  <td style="padding: 8px 0; color: #247d52; font-weight: 700;">${limitDateBr}</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0 0 0; color: #64748b; font-weight: 600; vertical-align: top;" colspan="2">Relato do Problema:</td>
                </tr>
                <tr>
                  <td style="padding: 10px; color: #334155; font-style: italic; background-color: #ffffff; border-radius: 8px; border: 1px dashed #cbd5e1; margin-top: 6px;" colspan="2">
                    ${ticket.description}
                  </td>
                </tr>
              </table>
            </div>

            <p style="font-size: 13px; color: #64748b; margin-bottom: 24px;">Você pode rastrear a resolução e interagir diretamente por meio do canal de acompanhamento do painel utilizando o seu código.</p>
            
            <div style="text-align: center; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 24px;">
              <span style="font-size: 11px; color: #94a3b8; display: block; font-weight: 500;">E-mail disparado automaticamente pelo Serviço de Facilities da Risel.</span>
              <span style="font-size: 11px; color: #94a3b8; display: block; font-weight: 500; margin-top: 2px;">&copy; Risel Facilities. Todos os direitos reservados.</span>
            </div>
          </div>
        </div>
      `;

      const ccList = [smtpUser];
      // Envia aviso ao gestor de facilities quando um chamado é aberto
      if (!isUpdate) {
        ccList.push("deny.goncalves@risel.com.br");
      }

      // Processar anexos (fotos) de forma robusta
      const attachments = [];
      if (ticket.photos && Array.isArray(ticket.photos)) {
        ticket.photos.forEach((photo: string, index: number) => {
          if (photo.startsWith("data:")) {
            const matches = photo.match(/^data:(image\/\w+);base64,(.+)$/);
            if (matches) {
              const contentType = matches[1];
              const extension = contentType.split('/')[1] || 'png';
              const base64Data = matches[2];
              attachments.push({
                filename: `anexo_chamado_${index + 1}.${extension}`,
                content: Buffer.from(base64Data, 'base64'),
                contentType: contentType
              });
            }
          } else if (photo.startsWith("http")) {
            attachments.push({
              filename: `anexo_chamado_${index + 1}.jpg`,
              path: photo
            });
          }
        });
      }

      const mailOptions = {
        from: `"Risel Facilities" <${smtpUser}>`,
        to: ticket.requesterEmail,
        cc: ccList.join(", "),
        subject: subject,
        html: htmlContent,
        attachments: attachments,
      };

      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: "E-mail de notificação enviado com sucesso!" });
    } catch (error: any) {
      console.error("Erro ao enviar e-mail via SMTP Gmail:", error);
      res.status(500).json({ error: "Falha ao enviar e-mail de notificação: " + error.message });
    }
  });

  // Teste de SMTP de e-mails em tempo real
  app.post("/api/test-email", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "E-mail de teste de destino não informado." });
      }

      const smtpUser = process.env.SMTP_USER || "facilitiesrisel@gmail.com";
      const smtpPass = process.env.SMTP_PASS || "@Cap150957";

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
        tls: {
          rejectUnauthorized: false
        }
      });

      const mailOptions = {
        from: `"Teste Risel" <${smtpUser}>`,
        to: email,
        subject: "[Risel Facilities] E-mail de Teste de Diagnóstico",
        html: `
          <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #cbd5e1; border-radius: 12px; padding: 24px; background-color: #f8fafc;">
            <h2 style="color: #0f172a; margin-top: 0;">✓ Teste de SMTP bem-sucedido!</h2>
            <p style="color: #334155; font-size: 14px; line-height: 1.5;">O seu servidor configurado no Render conseguiu se autenticar com sucesso no servidor de SMTP do Gmail e enviar esta mensagem.</p>
            <div style="margin-top: 20px; padding: 12px; background-color: #f1f5f9; border-radius: 8px; font-size: 12px; color: #475569;">
              <strong>Configuração utilizada:</strong><br>
              • Usuário SMTP: ${smtpUser}<br>
              • Porta: 465 (SSL)
            </div>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      return res.json({ success: true, message: "E-mail enviado com sucesso!" });
    } catch (error: any) {
      console.error("Erro no teste de SMTP:", error);
      let advice = "Dica: Verifique se o e-mail e a senha estão corretos.";
      if (error.message.includes("535") || error.message.toLowerCase().includes("accepted")) {
        advice = "Dica: O Gmail rejeitou as credenciais. Se você tem Verificação de Duas Etapas ativa, você DEVE gerar uma 'Senha de App' (App Password) de 16 dígitos nas configurações de Segurança da sua conta Google e usá-la no campo SMTP_PASS, em vez da sua senha de login padrão.";
      }
      return res.status(500).json({ 
        error: error.message, 
        advice,
        code: error.code || "SMTP_ERROR"
      });
    }
  });

  // Middleware do Vite (Desenvolvimento vs Produção)
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor de e-mails e aplicação rodando com sucesso na porta ${PORT}`);
  });
}

startServer();
