const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER || 'testingforcompany.0@gmail.com',
    pass: process.env.EMAIL_PASS || 'qxmj ibnc fleg gsyy'
  }
});

const sendEmailReply = async (toEmail, subject, htmlBody, inReplyTo, references) => {
  try {
    const mailOptions = {
      from: `"ElderCare CRM" <${process.env.EMAIL_USER || 'testingforcompany.0@gmail.com'}>`,
      to: toEmail,
      subject: subject,
      html: htmlBody,
      inReplyTo: inReplyTo,
      references: references
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Nodemailer Error:', err);
    return { success: false, error: err.message };
  }
};

module.exports = { sendEmailReply };
